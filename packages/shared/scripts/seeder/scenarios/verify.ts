import { queryAnalytics } from "../../../src/server";
import { ScenarioContext } from "./types";

/**
 * Cheap post-write readback. Not a verification framework — just enough for
 * the CLI to fail loudly when rows did not land.
 */
export const countRows = async (
  table: string,
  whereSql: string,
  params: Record<string, string | number | string[]>,
  countExpr = "COUNT(*)",
): Promise<number> => {
  const rows = await queryAnalytics<{ c: string | number }>({
    query: `SELECT ${countExpr} AS c FROM ${table} WHERE ${whereSql}`,
    params,
  });
  return Number(rows[0]?.c ?? 0);
};

/** Escapes LIKE-special characters so id prefixes match literally. */
export const escapeLike = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/[%_]/g, (match) => `\\${match}`);

export const traceLink = (
  ctx: ScenarioContext,
  traceId: string,
  timestampMs: number,
): string =>
  `${ctx.baseUrl}/project/${ctx.projectId}/traces/${encodeURIComponent(traceId)}?timestamp=${encodeURIComponent(new Date(timestampMs).toISOString())}`;

export const sessionLink = (ctx: ScenarioContext, sessionId: string): string =>
  `${ctx.baseUrl}/project/${ctx.projectId}/sessions/${encodeURIComponent(sessionId)}`;

export const tracesListLink = (ctx: ScenarioContext): string =>
  `${ctx.baseUrl}/project/${ctx.projectId}/traces`;
