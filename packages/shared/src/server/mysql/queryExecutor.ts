/**
 * MySQL query executor that replaces ClickHouse queryClickhouse.
 */
import { getMySqlPool } from "./client";
import { translateQuery } from "./sqlTranslator";
import { logger } from "../logger";
import { getTracer, instrumentAsync } from "../instrumentation";
import { SpanKind } from "@opentelemetry/api";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

/** Compatible with ClickhouseQueryOpts */
export type MySqlQueryOpts = {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string | undefined>;
  clickhouseConfigs?: unknown;
  clickhouseSettings?: unknown;
  preferredClickhouseService?: unknown;
  useMultipartParamsAuto?: boolean;
  allowLegacyEventsRead?: boolean;
};

/**
 * Execute a query against MySQL, replacing queryClickhouse.
 */
export async function queryMySql<T>(opts: MySqlQueryOpts): Promise<T[]> {
  return await instrumentAsync(
    { name: "mysql-query", spanKind: SpanKind.CLIENT },
    async (span) => {
      const { sql, params } = translateQuery(opts.query, opts.params);

      span.setAttribute("db.system", "mysql");
      if (opts.tags) {
        for (const [k, v] of Object.entries(opts.tags)) {
          if (v) span.setAttribute(`db.tag.${k}`, v);
        }
      }

      const pool = getMySqlPool();
      const [rows] = await pool.query<RowDataPacket[]>(sql, params);
      return rows as unknown as T[];
    },
  );
}

/**
 * Execute a query that returns a single result (e.g., COUNT).
 */
export async function queryMySqlScalar<T>(opts: MySqlQueryOpts): Promise<T> {
  const rows = await queryMySql<Record<string, T>>(opts);
  if (rows.length > 0) {
    const firstValue = Object.values(rows[0])[0];
    return firstValue;
  }
  return undefined as T;
}

/**
 * Execute a write/upsert operation against MySQL.
 */
export async function executeMySql(
  sql: string,
  params?: unknown[],
): Promise<ResultSetHeader> {
  const pool = getMySqlPool();
  const [result] = await pool.query<ResultSetHeader>(sql, params);
  return result;
}

/**
 * Execute a command (DDL) against MySQL.
 */
export async function commandMySql(
  sql: string,
  params?: unknown[],
): Promise<void> {
  const pool = getMySqlPool();
  await pool.query(sql, params);
}

/**
 * Stream rows from MySQL using cursor-based pagination.
 */
export async function* streamMySql<T>(
  opts: MySqlQueryOpts,
  batchSize: number = 1000,
): AsyncGenerator<T> {
  const { sql, params } = translateQuery(opts.query, opts.params);

  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const batchSql = `${sql} LIMIT ${batchSize} OFFSET ${offset}`;
    const pool = getMySqlPool();
    const [rows] = await pool.query<RowDataPacket[]>(batchSql, params);

    if (rows.length === 0) {
      hasMore = false;
    } else {
      for (const row of rows) {
        yield row as unknown as T;
      }
      if (rows.length < batchSize) {
        hasMore = false;
      } else {
        offset += batchSize;
      }
    }
  }
}
