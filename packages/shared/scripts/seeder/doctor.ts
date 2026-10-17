import { prisma } from "../../src/db";
import { queryAnalytics, redis } from "../../src/server";
import { SeedError } from "./scenarios/types";

type CheckStatus = "pass" | "warn" | "fail";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};

const FIX = {
  envFile: "cp .env.dev.example .env  (then review required values)",
  infraUp: "pnpm run infra:dev:up",
  chMigrate: "pnpm --filter=shared run ch:up",
  chDevTables: "pnpm --filter=shared run ch:dev-tables",
  dbMigrate: "pnpm --filter=shared run db:migrate",
  dbSeed:
    "pnpm --filter=shared run db:seed  (creates the default seed projects)",
  devWeb: "pnpm run dev:web",
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const checkEnvFile = (): CheckResult => {
  // Keep in sync with REQUIRED_ENV_VARS in ../cli.ts (the bootstrap checks
  // them before importing src/server, whose env schema would otherwise throw).
  // === undefined, not falsy — empty strings are valid for some of these
  // (matches the bootstrap precheck in ../cli.ts)
  const missing = ["DATABASE_URL", "LANGFUSE_MYSQL_URL"].filter(
    (name) => process.env[name] === undefined,
  );
  return missing.length === 0
    ? { name: "env", status: "pass", detail: "required env vars present" }
    : {
        name: "env",
        status: "fail",
        detail: `missing env vars: ${missing.join(", ")} — is the repo-root .env present?`,
        fix: FIX.envFile,
      };
};

const checkPostgres = async (): Promise<CheckResult> => {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 4000);
    return { name: "postgres", status: "pass", detail: "reachable" };
  } catch (error) {
    return {
      name: "postgres",
      status: "fail",
      detail: `cannot reach Postgres: ${(error as Error).message}`,
      fix: FIX.infraUp,
    };
  }
};

const checkMigrations = async (): Promise<CheckResult> => {
  try {
    const rows = await withTimeout(
      prisma.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
      4000,
    );
    const applied = Number(rows[0]?.count ?? 0);
    return applied > 0
      ? {
          name: "postgres-migrations",
          status: "pass",
          detail: `${applied} migrations applied`,
        }
      : {
          name: "postgres-migrations",
          status: "fail",
          detail: "no applied migrations found",
          fix: FIX.dbMigrate,
        };
  } catch (error) {
    return {
      name: "postgres-migrations",
      status: "fail",
      detail: `cannot read _prisma_migrations: ${(error as Error).message}`,
      fix: FIX.dbMigrate,
    };
  }
};

const checkProject = async (projectId: string): Promise<CheckResult> => {
  try {
    const project = await withTimeout(
      prisma.project.findUnique({ where: { id: projectId } }),
      4000,
    );
    return project
      ? {
          name: "project",
          status: "pass",
          detail: `project ${projectId} exists`,
        }
      : {
          name: "project",
          status: "fail",
          detail: `project ${projectId} not found in Postgres`,
          fix: `${FIX.dbSeed} — or pass an existing project via --project <id>`,
        };
  } catch (error) {
    // checkPostgres already proves connectivity, so a failure here is most
    // likely a missing table (Prisma P2021 — migrations not applied); only
    // P1xxx codes indicate connection-level problems.
    const prismaCode = (error as { code?: string }).code ?? "";
    return {
      name: "project",
      status: "fail",
      detail: (error as Error).message,
      fix: prismaCode.startsWith("P1") ? FIX.infraUp : FIX.dbMigrate,
    };
  }
};

const fetchAnalyticsTables = async (): Promise<Set<string>> => {
  const rows = await withTimeout(
    queryAnalytics<{ table_name: string }>({
      query: `SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_NAME IN ('traces', 'observations', 'scores', 'events_full', 'events_core')`,
    }),
    4000,
  );
  return new Set(rows.map((row) => row.table_name));
};

const checkAnalytics = async (): Promise<{
  connectivity: CheckResult;
  legacyTables: CheckResult;
  v4Tables: CheckResult;
}> => {
  let tables: Set<string>;
  try {
    tables = await fetchAnalyticsTables();
  } catch (error) {
    const fail: CheckResult = {
      name: "analytics",
      status: "fail",
      detail: `cannot reach Analytics: ${(error as Error).message}`,
      fix: FIX.infraUp,
    };
    return {
      connectivity: fail,
      legacyTables: {
        name: "analytics-tables",
        status: "fail",
        detail: "skipped (no connection)",
        // migration commands need a reachable Analytics; fix the root cause
        fix: FIX.infraUp,
      },
      v4Tables: {
        name: "analytics-v4-tables",
        status: "warn",
        detail: "skipped (no connection)",
        fix: FIX.infraUp,
      },
    };
  }

  const legacyMissing = ["traces", "observations", "scores"].filter(
    (table) => !tables.has(table),
  );
  const v4Missing = ["events_full", "events_core"].filter(
    (table) => !tables.has(table),
  );

  return {
    connectivity: { name: "analytics", status: "pass", detail: "reachable" },
    legacyTables:
      legacyMissing.length === 0
        ? {
            name: "analytics-tables",
            status: "pass",
            detail: "traces/observations/scores present",
          }
        : {
            name: "analytics-tables",
            status: "fail",
            detail: `missing tables: ${legacyMissing.join(", ")} — migrations not applied`,
            fix: FIX.chMigrate,
          },
    v4Tables:
      v4Missing.length === 0
        ? {
            name: "analytics-v4-tables",
            status: "pass",
            detail: "events_full/events_core present",
          }
        : {
            name: "analytics-v4-tables",
            status: "warn",
            detail: `missing v4 dev tables: ${v4Missing.join(", ")} — --v4 scenarios unavailable`,
            fix: FIX.chDevTables,
          },
  };
};

const checkAnalyticsMemory = async (): Promise<CheckResult> => {
  try {
    // MySQL doesn't expose memory metrics like ClickHouse's system.asynchronous_metrics.
    // Skip this check for MySQL backend.
    return {
      name: "analytics-memory",
      status: "pass",
      detail: "memory metrics unavailable (MySQL backend, skipped)",
    };
  } catch {
    return {
      name: "analytics-memory",
      status: "pass",
      detail: "memory metrics unavailable (skipped)",
    };
  }
};

// Original ClickHouse memory check replaced with MySQL-compatible stub
const _checkAnalyticsMemory = async (): Promise<CheckResult> => {
  try {
    const rows = await withTimeout(
      queryAnalytics<{ resident: number; total: number }>({
        query: `SELECT 0 AS resident, 0 AS total`,
      }),
      4000,
    );
    const resident = Number(rows[0]?.resident ?? 0);
    const total = Number(rows[0]?.total ?? 0);
    if (total <= 0) {
      return {
        name: "analytics-memory",
        status: "pass",
        detail: "memory metrics unavailable (skipped)",
      };
    }
    const ratio = resident / total;
    const summary = `${(resident / 1024 ** 3).toFixed(1)} GiB of ${(total / 1024 ** 3).toFixed(1)} GiB`;
    // Long-running local servers accumulate memory and large seeds then die
    // with MEMORY_LIMIT_EXCEEDED even though connectivity checks pass.
    return ratio < 0.7
      ? { name: "analytics-memory", status: "pass", detail: summary }
      : {
          name: "analytics-memory",
          status: "warn",
          detail: `${summary} — large seeds may hit MEMORY_LIMIT_EXCEEDED`,
          fix: "docker restart langfuse-analytics  (frees memory; data persists on the volume)",
        };
  } catch {
    return {
      name: "analytics-memory",
      status: "pass",
      detail: "memory metrics unavailable (skipped)",
    };
  }
};

const checkRedis = async (): Promise<CheckResult> => {
  if (!redis) {
    return {
      name: "redis",
      status: "warn",
      detail:
        "redis client not configured (only needed for ingestion/worker paths)",
      fix: FIX.infraUp,
    };
  }
  try {
    await withTimeout(redis.ping(), 2500);
    return { name: "redis", status: "pass", detail: "reachable" };
  } catch (error) {
    return {
      name: "redis",
      status: "warn",
      detail: `cannot reach Redis: ${(error as Error).message}`,
      fix: FIX.infraUp,
    };
  }
};

const checkHttp = async (
  name: string,
  url: string,
  fix: string,
  detailOnPass: string,
): Promise<CheckResult> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) {
      return {
        name,
        status: "warn",
        detail: `${url} returned HTTP ${response.status}`,
        fix,
      };
    }
    return { name, status: "pass", detail: detailOnPass };
  } catch {
    return { name, status: "warn", detail: `no response from ${url}`, fix };
  }
};

const checkMinio = async (): Promise<CheckResult> => {
  // CLI script, not a turbo task — probes the dev env directly.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const endpoint = process.env.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT;
  if (!endpoint) {
    return {
      name: "blob-storage",
      status: "warn",
      detail:
        "LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT not set (only needed for media/event uploads)",
      fix: "set LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT in .env (e.g. http://localhost:9090) if media/event upload tests are needed",
    };
  }
  return checkHttp(
    "blob-storage",
    `${endpoint.replace(/\/$/, "")}/minio/health/live`,
    FIX.infraUp,
    `reachable at ${endpoint}`,
  );
};

export const runDoctor = async (
  baseUrl: string,
  projectId: string,
): Promise<{ ok: boolean; checks: CheckResult[] }> => {
  const env = checkEnvFile();
  if (env.status === "fail") {
    return { ok: false, checks: [env] };
  }

  const [
    postgres,
    migrations,
    project,
    analytics,
    analyticsMemory,
    redisCheck,
    minio,
    web,
  ] = await Promise.all([
    checkPostgres(),
    checkMigrations(),
    checkProject(projectId),
    checkAnalytics(),
    checkAnalyticsMemory(),
    checkRedis(),
    checkMinio(),
    checkHttp(
      "web-app",
      `${baseUrl}/api/public/health`,
      FIX.devWeb,
      `responding at ${baseUrl} (deep links will work)`,
    ),
  ]);

  const checks = [
    env,
    postgres,
    migrations,
    project,
    analytics.connectivity,
    analytics.legacyTables,
    analytics.v4Tables,
    analyticsMemory,
    redisCheck,
    minio,
    web,
  ];
  return { ok: checks.every((check) => check.status !== "fail"), checks };
};

/**
 * Fast subset of doctor that scenario runs execute first, so a broken stack
 * fails in seconds with the exact fix instead of a stack trace mid-insert.
 */
export const preflight = async (opts: {
  projectId: string;
  needV4: boolean;
  log: (message: string) => void;
}): Promise<void> => {
  const env = checkEnvFile();
  if (env.status === "fail") {
    throw new SeedError(env.detail, env.fix);
  }

  const [postgres, project, analytics] = await Promise.all([
    checkPostgres(),
    checkProject(opts.projectId),
    checkAnalytics(),
  ]);

  const required: CheckResult[] = [
    postgres,
    project,
    analytics.connectivity,
    analytics.legacyTables,
  ];
  if (opts.needV4) {
    required.push({
      ...analytics.v4Tables,
      status:
        analytics.v4Tables.status === "warn"
          ? "fail"
          : analytics.v4Tables.status,
    });
  }

  const failed = required.find((check) => check.status === "fail");
  if (failed) {
    throw new SeedError(
      `preflight failed [${failed.name}]: ${failed.detail}`,
      failed.fix,
    );
  }
  opts.log("preflight ok (postgres, project, analytics)");
};
