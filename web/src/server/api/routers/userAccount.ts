import { z } from "zod";
import {
  createTRPCRouter,
  authenticatedProcedure,
} from "@/src/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { StringNoHTML } from "@langfuse/shared";
import { Role, Prisma, type PrismaClient } from "@langfuse/shared/src/db";
// canToggleV4 (v4Rollout) was needed by the removed setV4BetaEnabled
// procedure; the session callback in auth.ts still uses the same helper.
// V4_PREVIEW_LABEL was removed together with the legacy V3 toggle.
import { env } from "@/src/env.mjs";
import { getSfdcService } from "@/src/ee/features/sfdc-sync/server";
import { featurePreviewFlags } from "@/src/features/feature-flags/available-flags";
import { setUserFeaturePreview } from "@/src/features/feature-flags/server/organizationFeatureFlags";
import { advanceSessionsExpiredAtForUser } from "@/src/features/auth/lib/sessionExpiration";

const updateDisplayNameSchema = z.object({
  name: StringNoHTML.min(1, "Name cannot be empty").max(
    100,
    "Name must be at most 100 characters",
  ),
});

/**
 * Helper function to check if a user can be deleted.
 * A user can only be deleted if they are not the last owner of any organization.
 */
async function checkUserCanBeDeleted(
  userId: string,
  prisma:
    | Omit<
        PrismaClient,
        | "$connect"
        | "$disconnect"
        | "$on"
        | "$transaction"
        | "$use"
        | "$extends"
      >
    | Prisma.TransactionClient,
) {
  // Find all organizations where user is an owner
  const organizationMemberships = await prisma.organizationMembership.findMany({
    where: {
      userId,
      role: Role.OWNER,
    },
    include: {
      organization: {
        include: {
          organizationMemberships: {
            where: {
              role: Role.OWNER,
            },
          },
        },
      },
    },
  });

  // Filter to find organizations where user is the ONLY owner
  const organizationsWhereLastOwner = organizationMemberships
    .filter((membership) => {
      const ownerCount = membership.organization.organizationMemberships.length;
      return ownerCount === 1; // User is the only owner
    })
    .map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
    }));

  return {
    canDelete: organizationsWhereLastOwner.length === 0,
    blockingOrganizations: organizationsWhereLastOwner,
  };
}

export const userAccountRouter = createTRPCRouter({
  checkCanDelete: authenticatedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    return checkUserCanBeDeleted(userId, ctx.prisma);
  }),

  updateDisplayName: authenticatedProcedure
    .input(updateDisplayNameSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;

      const updatedUser = await ctx.prisma.user.update({
        where: { id: userId },
        data: {
          name: input.name,
        },
      });

      return {
        success: true,
        name: updatedUser.name,
      };
    }),

  signOutAllSessions: authenticatedProcedure.mutation(async ({ ctx }) => {
    await advanceSessionsExpiredAtForUser(ctx.session.user.id, ctx.prisma);

    return { success: true };
  }),

  setFeaturePreviewEnabled: authenticatedProcedure
    .input(
      z.object({
        // Allowlist of user-toggleable Feature Preview flags (the Feature
        // Preview modal). Keep in sync with the modal's preview registry.
        flag: z.enum(featurePreviewFlags),
        enabled: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.session.user.id;

      // v4BetaEnabled is force-true in events_only write mode (this
      // deployment), so self-hosted feature previews work without the
      // removed V4 Preview toggle.
      const canEnableFeaturePreviews =
        Boolean(env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION) ||
        ctx.session.user.v4BetaEnabled === true;

      if (input.enabled && !canEnableFeaturePreviews) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Feature previews require the v4 read path on self-hosted deployments.`,
        });
      }

      // The helper serializes and retries the read-modify-write so parallel
      // toggles of different flags cannot silently drop one another.
      await setUserFeaturePreview({
        prisma: ctx.prisma,
        userId,
        flag: input.flag,
        enabled: input.enabled,
      });

      return {
        success: true,
        flag: input.flag,
        enabled: input.enabled,
      };
    }),

  delete: authenticatedProcedure.mutation(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    // Wrap check and delete in a serializable transaction to prevent race conditions
    // when organization owners are removed concurrently
    const sfdcRemovals = await ctx.prisma.$transaction(
      async (tx) => {
        // Verify user can be deleted
        const { canDelete } = await checkUserCanBeDeleted(userId, tx);

        if (!canDelete) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Cannot delete account. You are the last owner of one or more organizations. Please add another owner or delete the organizations first.",
          });
        }

        // Capture org memberships before the cascade delete wipes them; they
        // are synced to SFDC only after the transaction commits. NONE roles
        // hold no SFDC org-member bridge, so there is nothing to remove.
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });
        const memberships = await tx.organizationMembership.findMany({
          where: { userId, role: { not: Role.NONE } },
          select: { orgId: true },
        });

        // Delete the user (cascade will handle related records)
        await tx.user.delete({
          where: { id: userId },
        });

        return memberships.map(({ orgId }) => ({
          orgId,
          email: user?.email,
        }));
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    // SFDC: remove every org-member bridge the cascade just deleted. After
    // commit so a rolled-back delete never desyncs SFDC; removeUser never
    // throws, so per-org failures cannot fail the mutation.
    await Promise.all(
      sfdcRemovals.map(({ orgId, email }) =>
        getSfdcService()?.removeUser({ orgId, userId, email }),
      ),
    );

    return {
      success: true,
    };
  }),

});
