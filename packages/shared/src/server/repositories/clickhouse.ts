/**
 * ClickHouse query interface — now backed by MySQL.
 *
 * This module preserves the original export signatures so that all callers
 * (23+ repository files) continue to work without changes. Under the hood,
 * every function delegates to the MySQL executor + SQL translator.
 *
 * The ClickHouse-specific types (ClickHouseSettings, TupleParam, etc.) are
 * kept as no-ops or stubs for API compatibility.
 */
import { queryMySql, streamMySql, commandMySql, executeMySql, type MySqlQueryOpts } from "../mysql/queryExecutor.js";
import { translateQuery, parseClickhouseUTCDateTimeFormat as parseDate } from "../mysql/sqlTranslator.js";
import { logger } from "../logger";
import { randomUUID } from "crypto";

// ─── Re-exported types for compatibility ───

/** Stub: ClickHouse settings are not applicable to MySQL */
/** Stub: ClickHouse client config options (not needed for MySQL) */
export type ClickHouseClientConfigOptions = Record<string, unknown>;

export type ClickHouseSettings = Record<string, unknown>;

/** Stub: TupleParam is not needed for MySQL (arrays handled as JSON) */
export const TupleParam = Array;

/** Error class preserved for compatibility; MySQL errors are wrapped in it */
export class ClickHouseResourceError extends Error {
  static ERROR_ADVICE_MESSAGE = "An error occurred while querying the analytics store. Please try again later.";
  public readonly errorType: string = "UNKNOWN";
  public readonly tags?: Record<string, unknown>;

  constructor(errType: string, originalError: Error, tags?: Record<string, unknown>) {
    super(originalError.message, { cause: originalError });
    this.name = "ClickHouseResourceError";
    this.errorType = errType;
    this.tags = tags;
    if (originalError.stack) this.stack = originalError.stack;
  }

  static is(error: unknown): error is ClickHouseResourceError {
    return error instanceof ClickHouseResourceError;
  }

  static wrapIfResourceError(error: Error, _tags?: Record<string, unknown>): Error {
    // MySQL doesn't have CH resource errors; just return the original
    return error;
  }
}

// ─── Query options type (preserved interface) ───

export type ClickhouseQueryOpts = {
  query: string;
  params?: Record<string, unknown>;
  useMultipartParamsAuto?: boolean;
  clickhouseConfigs?: unknown;
  tags?: Record<string, string | undefined>;
  preferredClickhouseService?: unknown;
  clickhouseSettings?: ClickHouseSettings;
  allowLegacyEventsRead?: boolean;
  format?: string;
  queryId?: string;
};

// ─── Core query functions ───

/**
 * Execute a query and return typed results.
 * Replaces the ClickHouse implementation with MySQL.
 */
export async function queryClickhouse<T>(opts: ClickhouseQueryOpts): Promise<T[]> {
  try {
    return await queryMySql<T>({
      query: opts.query,
      params: opts.params,
      tags: opts.tags,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("MySQL query error (queryClickhouse)", err, {
      query: opts.query?.substring(0, 200),
    });
    throw err;
  }
}

/**
 * Execute a raw SQL command (DDL, etc.).
 */
export async function queryClickhouseExecRaw(opts: {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string | undefined>;
  clickhouseConfigs?: unknown;
  preferredClickhouseService?: unknown;
  format?: string;
  clickhouseSettings?: Record<string, unknown>;
}): Promise<ClickhouseExecRawResult> {
  const { sql, params } = translateQuery(opts.query, opts.params);
  try {
    const result = await executeMySql(sql, params);
    return {
      rows: [] as Record<string, unknown>[],
      stats: { rowsAffected: result.affectedRows },
      queryId: "",
      stream: null as unknown as NodeJS.ReadableStream,
      responseHeaders: {},
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("MySQL exec error (queryClickhouseExecRaw)", err);
    throw err;
  }
}

export type ClickhouseExecRawResult = {
  rows: Record<string, unknown>[];
  stats: { rowsAffected: number };
  queryId: string;
  stream: NodeJS.ReadableStream;
  responseHeaders: Record<string, string>;
};
/**
 * Upsert records into MySQL.
 * Replaces the ClickHouse bulk insert.
 */
export async function upsertClickhouse<T extends Record<string, unknown>>(opts: {
  table: string;
  records: T[];
  tags?: Record<string, string | undefined>;
  format?: string;
  eventBodyMapper?: (record: T) => T;
  clickhouseSettings?: ClickHouseSettings;
  log_comment?: string;
}): Promise<void> {
  if (opts.records.length === 0) return;

  // Apply event body mapper if provided (CH compatibility)
  const records = opts.eventBodyMapper
    ? opts.records.map(opts.eventBodyMapper)
    : opts.records;

  const { getMySqlPool } = await import("../mysql/client.js");
  const pool = getMySqlPool();
  const columns = Object.keys(records[0]);
  const colList = columns.map((c) => `\`${c}\``).join(", ");
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const allPlaceholders = records.map(() => rowPlaceholder).join(", ");
  const updateSet = columns
    .filter((c) => c !== "id" && c !== "span_id")
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
    .join(", ");

  const sql = `INSERT INTO \`${opts.table}\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${updateSet}`;

  const allParams: unknown[] = [];
  for (const record of records) {
    for (const col of columns) {
      const value = record[col];
      if (value === null || value === undefined) allParams.push(null);
      else if (typeof value === "object") allParams.push(JSON.stringify(value));
      else if (value instanceof Date) allParams.push(value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, ""));
      else allParams.push(value);
    }
  }

  await pool.query(sql, allParams);
}

/**
 * Stream query results with pagination.
 */
export async function* queryClickhouseStream<T>(
  opts: ClickhouseQueryOpts,
): AsyncGenerator<T> {
  yield* streamMySql<T>({
    query: opts.query,
    params: opts.params,
    tags: opts.tags,
  });
}

/**
 * Stream raw text results (for exports).
 */
export async function* queryClickhouseStreamRawText(
  opts: ClickhouseQueryOpts,
): AsyncGenerator<string> {
  for await (const row of streamMySql<Record<string, unknown>>({
    query: opts.query,
    params: opts.params,
    tags: opts.tags,
  })) {
    yield JSON.stringify(row);
  }
}

/**
 * Stream with progress (simplified for MySQL — no progress tracking).
 */
export async function* queryClickhouseWithProgress<T>(
  opts: ClickhouseQueryOpts,
): AsyncGenerator<T> {
  yield* streamMySql<T>({
    query: opts.query,
    params: opts.params,
    tags: opts.tags,
  });
}

/**
 * Execute a DDL command.
 */
export async function commandClickhouse(opts: {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string | undefined>;
  clickhouseConfigs?: unknown;
  clickhouseSettings?: Record<string, unknown>;
  queryId?: string;
  preferredClickhouseService?: unknown;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sql, params } = translateQuery(opts.query, opts.params);
  await commandMySql(sql, params);
}

/** Stub: blob export settings not applicable to MySQL */
export const BLOB_EXPORT_PARQUET_CLICKHOUSE_SETTINGS: ClickHouseSettings = {};

/**
 * Parse datetime string to Date.
 * Preserved for compatibility — works with both CH and MySQL datetime strings.
 */
export { parseDate as parseClickhouseUTCDateTimeFormat };

/**
 * Generate random characters (for unique IDs, etc.).
 * Preserved for compatibility.
 */
export function clickhouseCompliantRandomCharacters(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  const randomArray = new Uint8Array(5);
  crypto.getRandomValues(randomArray);
  randomArray.forEach((number) => {
    result += chars[number % chars.length];
  });
  return result;
}

// ─── Re-exported types from @clickhouse/client (stubs) ───

export type RowOrProgress = Record<string, unknown>;

export function isProgressRow(_row: unknown): boolean {
  return false; // MySQL doesn't have progress rows
}

export function isRow(row: unknown): boolean {
  return typeof row === "object" && row !== null;
}

export function isException(_row: unknown): boolean {
  return false; // MySQL doesn't have exception rows
}
