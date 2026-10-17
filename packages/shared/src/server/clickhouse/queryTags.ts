/**
 * Query tags for analytics store queries.
 * Preserved for compatibility with callers that build query tag objects.
 */
import { context, propagation } from "@opentelemetry/api";

export const CLICKHOUSE_QUERY_TAG_SCHEMA_VERSION = "1" as const;
const UNKNOWN_CLICKHOUSE_QUERY_TAG_VALUE = "unknown" as const;

export type ClickHouseQuerySurface =
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

const CLICKHOUSE_QUERY_SURFACES: readonly ClickHouseQuerySurface[] = [
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

const isClickHouseQuerySurface = (
  surface: string,
): surface is ClickHouseQuerySurface =>
  (CLICKHOUSE_QUERY_SURFACES as readonly string[]).includes(surface);

export type NormalizedClickHouseQueryTags = {
  tag_schema_version: string;
  surface: string;
  route?: string;
  projectId?: string;
  experimentId?: string;
  sdkName?: string;
  sdkVersion?: string;
  userAgent?: string;
};

export type ClickHouseQueryTags = {
  surface?: string;
  route?: string;
  projectId?: string;
  experimentId?: string;
  sdkName?: string;
  sdkVersion?: string;
  userAgent?: string;
};

export const CLICKHOUSE_QUERY_TAG_BAGGAGE_KEYS = {
  surface: "langfuse.clickhouse.surface",
  route: "langfuse.clickhouse.route",
  projectId: "langfuse.project.id",
  sdkName: "langfuse.clickhouse.sdk_name",
  sdkVersion: "langfuse.clickhouse.sdk_version",
  userAgent: "langfuse.clickhouse.user_agent",
} as const;

export const normalizeClickHouseQueryTags = (
  tags?: ClickHouseQueryTags,
): NormalizedClickHouseQueryTags => {
  const baggage = propagation.getBaggage(context.active());
  const surface =
    tags?.surface ??
    baggage?.getEntry(CLICKHOUSE_QUERY_TAG_BAGGAGE_KEYS.surface)?.value;
  const route =
    tags?.route ??
    baggage?.getEntry(CLICKHOUSE_QUERY_TAG_BAGGAGE_KEYS.route)?.value;
  const projectId =
    tags?.projectId ??
    baggage?.getEntry(CLICKHOUSE_QUERY_TAG_BAGGAGE_KEYS.projectId)?.value;
  const sdkName =
    tags?.sdkName ??
    baggage?.getEntry(CLICKHOUSE_QUERY_TAG_BAGGAGE_KEYS.sdkName)?.value;
  const sdkVersion =
    tags?.sdkVersion ??
    baggage?.getEntry(CLICKHOUSE_QUERY_TAG_BAGGAGE_KEYS.sdkVersion)?.value;
  const userAgent =
    tags?.userAgent ??
    baggage?.getEntry(CLICKHOUSE_QUERY_TAG_BAGGAGE_KEYS.userAgent)?.value;
  const normalizedRoute = typeof route === "string" ? route.trim() : "";
  const isPublicApi = surface === "public-api" || surface === "publicapi";
  const normalizedSdkName =
    sdkName === "python" || sdkName === "javascript" ? sdkName : undefined;
  const normalizedSdkVersion =
    typeof sdkVersion === "string" ? sdkVersion.trim() : "";
  const normalizedUserAgent =
    typeof userAgent === "string" ? userAgent.trim() : "";

  return {
    tag_schema_version: CLICKHOUSE_QUERY_TAG_SCHEMA_VERSION,
    surface: isClickHouseQuerySurface(surface ?? "")
      ? surface!
      : UNKNOWN_CLICKHOUSE_QUERY_TAG_VALUE,
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

export function buildClickHouseLogComment(tags?: ClickHouseQueryTags): string {
  return JSON.stringify(normalizeClickHouseQueryTags(tags));
}
