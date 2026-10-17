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

export const normalizeClickHouseQueryTags = (
  tags?: ClickHouseQueryTags,
): NormalizedClickHouseQueryTags => {
  const surface = tags?.surface;
  const normalizedRoute = tags?.route;
  const projectId = tags?.projectId;

  const isPublicApi = surface === "public-api" || surface === "publicapi";
  const normalizedSdkName = isPublicApi ? tags?.sdkName : undefined;
  const normalizedSdkVersion = isPublicApi ? tags?.sdkVersion : undefined;
  const normalizedUserAgent = isPublicApi ? tags?.userAgent : undefined;

  return {
    tag_schema_version: CLICKHOUSE_QUERY_TAG_SCHEMA_VERSION,
    surface: isClickHouseQuerySurface(surface ?? "")
      ? surface!
      : UNKNOWN_CLICKHOUSE_QUERY_TAG_VALUE,
    ...(normalizedRoute ? { route: normalizedRoute } : {}),
    ...(projectId ? { projectId } : {}),
    ...(tags?.experimentId ? { experimentId: tags.experimentId } : {}),
    ...(isPublicApi && normalizedSdkName ? { sdkName: normalizedSdkName } : {}),
    ...(isPublicApi && normalizedSdkVersion ? { sdkVersion: normalizedSdkVersion } : {}),
    ...(isPublicApi && normalizedUserAgent ? { userAgent: normalizedUserAgent } : {}),
  };
};

export function buildClickHouseLogComment(tags?: ClickHouseQueryTags): string {
  return JSON.stringify(normalizeClickHouseQueryTags(tags));
}
