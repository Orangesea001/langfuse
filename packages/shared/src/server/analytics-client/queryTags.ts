/**
 * Query tags for analytics store queries.
 * Preserved for compatibility with callers that build query tag objects.
 */
import { context, propagation } from "@opentelemetry/api";

export const ANALYTICS_QUERY_TAG_SCHEMA_VERSION = "1" as const;
const UNKNOWN_ANALYTICS_QUERY_TAG_VALUE = "unknown" as const;

export type AnalyticsQuerySurface =
  | "public-api"
  | "publicapi"
  | "trpc"
  | "worker"
  | "dashboard"
  | "export"
  | "internal"
  | "eval"
  | "mcp"
  | "monitor"
  | "search";

const ANALYTICS_QUERY_SURFACES: readonly AnalyticsQuerySurface[] = [
  "public-api",
  "publicapi",
  "trpc",
  "worker",
  "dashboard",
  "export",
  "internal",
  "eval",
  "mcp",
  "monitor",
  "search",
];

const isAnalyticsQuerySurface = (
  surface: string,
): surface is AnalyticsQuerySurface =>
  (ANALYTICS_QUERY_SURFACES as readonly string[]).includes(surface);

export type NormalizedAnalyticsQueryTags = {
  tag_schema_version: string;
  surface: string;
  route?: string;
  projectId?: string;
  experimentId?: string;
  sdkName?: string;
  sdkVersion?: string;
  userAgent?: string;
};

export type AnalyticsQueryTags = {
  surface?: string;
  route?: string;
  projectId?: string;
  experimentId?: string;
  sdkName?: string;
  sdkVersion?: string;
  userAgent?: string;
};

export const ANALYTICS_QUERY_TAG_BAGGAGE_KEYS = {
  surface: "langfuse.analytics.surface",
  route: "langfuse.analytics.route",
  projectId: "langfuse.project.id",
  sdkName: "langfuse.analytics.sdk_name",
  sdkVersion: "langfuse.analytics.sdk_version",
  userAgent: "langfuse.analytics.user_agent",
} as const;

export const normalizeAnalyticsQueryTags = (
  tags?: AnalyticsQueryTags,
): NormalizedAnalyticsQueryTags => {
  const baggage = propagation.getBaggage(context.active());
  const surface =
    tags?.surface ??
    baggage?.getEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.surface)?.value;
  const route =
    tags?.route ??
    baggage?.getEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.route)?.value;
  const projectId =
    tags?.projectId ??
    baggage?.getEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.projectId)?.value;
  const sdkName =
    tags?.sdkName ??
    baggage?.getEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.sdkName)?.value;
  const sdkVersion =
    tags?.sdkVersion ??
    baggage?.getEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.sdkVersion)?.value;
  const userAgent =
    tags?.userAgent ??
    baggage?.getEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.userAgent)?.value;
  const normalizedRoute = typeof route === "string" ? route.trim() : "";
  const isPublicApi = surface === "public-api" || surface === "publicapi";
  const normalizedSdkName =
    sdkName === "python" || sdkName === "javascript" ? sdkName : undefined;
  const normalizedSdkVersion =
    typeof sdkVersion === "string" ? sdkVersion.trim() : "";
  const normalizedUserAgent =
    typeof userAgent === "string" ? userAgent.trim() : "";

  return {
    tag_schema_version: ANALYTICS_QUERY_TAG_SCHEMA_VERSION,
    surface: isAnalyticsQuerySurface(surface ?? "")
      ? surface!
      : UNKNOWN_ANALYTICS_QUERY_TAG_VALUE,
    ...(normalizedRoute ? { route: normalizedRoute } : {}),
    ...(projectId ? { projectId } : {}),
    ...(tags?.experimentId ? { experimentId: tags.experimentId } : {}),
    ...(isPublicApi && normalizedSdkName ? { sdkName: normalizedSdkName } : {}),
    ...(isPublicApi && normalizedSdkVersion
      ? { sdkVersion: normalizedSdkVersion }
      : {}),
    ...(isPublicApi && normalizedUserAgent
      ? { userAgent: normalizedUserAgent }
      : {}),
  };
};

export function buildAnalyticsLogComment(tags?: AnalyticsQueryTags): string {
  return JSON.stringify(normalizeAnalyticsQueryTags(tags));
}
