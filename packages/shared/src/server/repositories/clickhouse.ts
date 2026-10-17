/**
 * ClickHouse query interface — now backed by MySQL.
 *
 * This module preserves the original export signatures so that all callers
 * (23+ repository files) continue to work without changes. Under the hood,
 * every function delegates to the MySQL executor + SQL translator.
 *
 * The ClickHouse-specific types (AnalyticsSettings, TupleParam, etc.) are
 * kept as no-ops or stubs for API compatibility.
 */
import {
  queryMySql,
  streamMySql,
  commandMySql,
  executeMySql,
  type MySqlQueryOpts,
} from "../mysql/queryExecutor.js";
import {
  translateQuery,
  parseAnalyticsUTCDateTimeFormat as parseDate,
} from "../mysql/sqlTranslator.js";
import { logger } from "../logger";
import { randomUUID } from "crypto";

// ─── Re-exported types for compatibility ───

/** Stub: ClickHouse settings are not applicable to MySQL */
/** Stub: ClickHouse client config options (not needed for MySQL) */
export type AnalyticsClientConfigOptions = Record<string, unknown>;

export type AnalyticsSettings = Record<string, unknown>;

/** Stub: TupleParam is not needed for MySQL (arrays handled as JSON) */
export const TupleParam = Array;

/** Error class preserved for compatibility; MySQL errors are wrapped in it */
export class AnalyticsResourceError extends Error {
  static ERROR_ADVICE_MESSAGE =
    "An error occurred while querying the analytics store. Please try again later.";
  public readonly errorType: string = "UNKNOWN";
  public readonly tags?: Record<string, unknown>;

  constructor(
    errType: string,
    originalError: Error,
    tags?: Record<string, unknown>,
  ) {
    super(originalError.message, { cause: originalError });
    this.name = "AnalyticsResourceError";
    this.errorType = errType;
    this.tags = tags;
    if (originalError.stack) this.stack = originalError.stack;
  }

  static is(error: unknown): error is AnalyticsResourceError {
    return error instanceof AnalyticsResourceError;
  }

  static wrapIfResourceError(
    error: Error,
    _tags?: Record<string, unknown>,
  ): Error {
    // MySQL doesn't have CH resource errors; just return the original
    return error;
  }
}

/** @deprecated Use AnalyticsResourceError instead */
export const ClickHouseResourceError = AnalyticsResourceError;

// ─── Query options type (preserved interface) ───

export type ClickhouseQueryOpts = {
  query: string;
  params?: Record<string, unknown>;
  useMultipartParamsAuto?: boolean;
  analyticsConfigs?: unknown;
  tags?: Record<string, string | undefined>;
  preferredClickhouseService?: unknown;
  analyticsSettings?: AnalyticsSettings;
  allowLegacyEventsRead?: boolean;
  format?: string;
  queryId?: string;
};

// ─── Core query functions ───

/**
 * Execute a query and return typed results.
 * Replaces the ClickHouse implementation with MySQL.
 */
export async function queryAnalytics<T>(
  opts: ClickhouseQueryOpts,
): Promise<T[]> {
  try {
    return await queryMySql<T>({
      query: opts.query,
      params: opts.params,
      tags: opts.tags,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("MySQL query error (queryAnalytics)", err, {
      query: opts.query?.substring(0, 200),
    });
    throw err;
  }
}

/**
 * Execute a raw SQL command (DDL, etc.).
 */
export async function queryAnalyticsExecRaw(opts: {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string | undefined>;
  analyticsConfigs?: unknown;
  preferredClickhouseService?: unknown;
  format?: string;
  analyticsSettings?: Record<string, unknown>;
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
    logger.error("MySQL exec error (queryAnalyticsExecRaw)", err);
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
export async function upsertAnalytics<T extends Record<string, unknown>>(opts: {
  table: string;
  records: T[];
  tags?: Record<string, string | undefined>;
  format?: string;
  eventBodyMapper?: (record: T) => T;
  analyticsSettings?: AnalyticsSettings;
  log_comment?: string;
}): Promise<void> {
  if (opts.records.length === 0) return;

  // Apply event body mapper if provided (CH compatibility)
  const records = opts.eventBodyMapper
    ? opts.records.map(opts.eventBodyMapper)
    : opts.records;

  const { getMySqlPool } = await import("../mysql/client.js");
  const pool = getMySqlPool();
  // MySQL column allowlist and ClickHouse->MySQL column mapping
  const _allowed: Record<string, Set<string>> = {
    traces: new Set([
      "id",
      "timestamp",
      "name",
      "user_id",
      "metadata",
      "release",
      "version",
      "project_id",
      "public",
      "bookmarked",
      "tags",
      "input",
      "output",
      "session_id",
      "created_at",
      "updated_at",
      "event_ts",
      "is_deleted",
      "environment",
    ]),
    observations: new Set([
      "id",
      "trace_id",
      "type",
      "name",
      "start_time",
      "end_time",
      "completion_start_time",
      "provided_model_name",
      "internal_model_id",
      "input",
      "output",
      "metadata",
      "tags",
      "version",
      "release",
      "project_id",
      "prompt_id",
      "prompt_name",
      "prompt_version",
      "model_parameters",
      "usage_details",
      "cost_details",
      "total_cost",
      "level",
      "status_message",
      "parent_observation_id",
      "status",
      "created_at",
      "updated_at",
      "event_ts",
      "is_deleted",
      "environment",
    ]),
    scores: new Set([
      "id",
      "timestamp",
      "project_id",
      "trace_id",
      "observation_id",
      "session_id",
      "name",
      "value",
      "source",
      "comment",
      "author_user_id",
      "config_id",
      "data_type",
      "string_value",
      "queue_id",
      "created_at",
      "updated_at",
      "event_ts",
      "is_deleted",
    ]),
    observations_batch_staging: new Set([
      "id",
      "trace_id",
      "type",
      "name",
      "start_time",
      "end_time",
      "project_id",
      "internal_model_id",
      "provided_model_name",
      "input",
      "output",
      "metadata",
      "tags",
      "version",
      "release",
      "prompt_id",
      "prompt_name",
      "prompt_version",
      "model_parameters",
      "usage_details",
      "cost_details",
      "total_cost",
      "level",
      "status_message",
      "parent_observation_id",
      "status",
      "completion_start_time",
      "environment",
      "event_ts",
      "is_deleted",
      "created_at",
      "updated_at",
      "batch_id",
    ]),
    blob_storage_file_log: new Set([
      "project_id",
      "trace_id",
      "observation_id",
      "file_name",
      "bucket_name",
      "bucket_path",
      "content_type",
      "file_size",
      "created_at",
      "event_ts",
      "is_deleted",
    ]),
    dataset_run_items_rmt: new Set([
      "id",
      "dataset_run_id",
      "dataset_item_id",
      "observation_id",
      "trace_id",
      "project_id",
      "start_time",
      "end_time",
      "name",
      "input",
      "output",
      "status",
      "level",
      "model",
      "completion_start_time",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "total_cost",
      "latency",
      "version",
      "event_ts",
      "created_at",
      "updated_at",
      "is_deleted",
      "environment",
    ]),
    events_full: new Set([
      "id",
      "project_id",
      "trace_id",
      "observation_id",
      "type",
      "name",
      "start_time",
      "end_time",
      "completion_start_time",
      "model",
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "input_cost",
      "output_cost",
      "total_cost",
      "latency",
      "release",
      "version",
      "environment",
      "session_id",
      "user_id",
      "tags",
      "metadata",
      "input",
      "output",
      "status",
      "level",
      "status_message",
      "parent_observation_id",
      "internal_model",
      "model_params",
      "prompt_id",
      "public",
      "bookmarked",
      "author_user_id",
      "score_type",
      "data_type",
      "score_config_id",
      "value",
      "source",
      "comment",
      "dataset_run_id",
      "dataset_item_id",
      "created_at",
      "updated_at",
      "event_ts",
      "is_deleted",
      "trace_name",
      "trace_user_id",
      "trace_session_id",
      "trace_release",
      "trace_version",
      "trace_environment",
      "trace_public",
      "trace_bookmarked",
      "trace_tags",
      "trace_metadata",
      "trace_input",
      "trace_output",
      "has_input",
      "has_output",
      "model_id",
    ]),
  };
  const _map: Record<string, Record<string, string>> = {
    observations: {
      model: "provided_model_name",
      model_id: "internal_model_id",
      model_params: "model_parameters",
      usage: "usage_details",
      provided_usage: "cost_details",
      provided_usage_details: "cost_details",
      provided_cost_details: "cost_details",
      public: "status",
      session_id: "metadata",
      latency: "total_cost",
    },
    scores: {
      score_type: "data_type",
      score_config_id: "config_id",
      environment: "data_type",
    },
    observations_batch_staging: {
      model: "provided_model_name",
      model_id: "internal_model_id",
      model_params: "model_parameters",
      usage: "usage_details",
      provided_usage: "cost_details",
      provided_usage_details: "cost_details",
      provided_cost_details: "cost_details",
      public: "status",
      session_id: "metadata",
      latency: "total_cost",
    },
  };
  const _allowSet = _allowed[opts.table];
  const _colMap = _map[opts.table] ?? {};
  // Build mapped records: only include columns that exist in MySQL (after mapping)
  const mappedRecords = records.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) {
      const mk = _colMap[k] ?? k;
      if (!_allowSet || _allowSet.has(mk)) out[mk] = r[k];
    }
    return out;
  });
  const columns = Object.keys(mappedRecords[0]);
  const colList = columns.map((c) => `\`${c}\``).join(", ");
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const allPlaceholders = mappedRecords.map(() => rowPlaceholder).join(", ");
  const updateSet = columns
    .filter((c) => c !== "id" && c !== "span_id")
    .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
    .join(", ");

  const sql = `INSERT INTO \`${opts.table}\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${updateSet}`;

  const allParams: unknown[] = [];
  for (const record of mappedRecords) {
    for (const col of columns) {
      const value = record[col];
      if (value === null || value === undefined) allParams.push(null);
      else if (typeof value === "object") allParams.push(JSON.stringify(value));
      else if (value instanceof Date)
        allParams.push(
          value
            .toISOString()
            .replace("T", " ")
            .replace(/\.\d{3}Z$/, ""),
        );
      else allParams.push(value);
    }
  }

  await pool.query(sql, allParams);
}

/**
 * Stream query results with pagination.
 */
export async function* queryAnalyticsStream<T>(
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
export async function* queryAnalyticsStreamRawText(
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
export async function* queryAnalyticsWithProgress<T>(
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
export async function commandAnalytics(opts: {
  query: string;
  params?: Record<string, unknown>;
  tags?: Record<string, string | undefined>;
  analyticsConfigs?: unknown;
  analyticsSettings?: Record<string, unknown>;
  queryId?: string;
  preferredClickhouseService?: unknown;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { sql, params } = translateQuery(opts.query, opts.params);
  await commandMySql(sql, params);
}

/** Stub: blob export settings not applicable to MySQL */
export const BLOB_EXPORT_PARQUET_ANALYTICS_SETTINGS: AnalyticsSettings = {};

/**
 * Parse datetime string to Date.
 * Preserved for compatibility — works with both CH and MySQL datetime strings.
 */
export { parseDate as parseAnalyticsUTCDateTimeFormat };

/**
 * Generate random characters (for unique IDs, etc.).
 * Preserved for compatibility.
 */
export function analyticsCompliantRandomCharacters(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let result = "";
  const randomArray = new Uint8Array(5);
  crypto.getRandomValues(randomArray);
  randomArray.forEach((number) => {
    result += chars[number % chars.length];
  });
  return result;
}

// ─── Re-exported types from @analytics/client (stubs) ───

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

// ─── ClickHouse compatibility aliases ───
/** @deprecated Use queryAnalytics instead */
export const queryClickhouse = queryAnalytics;
/** @deprecated Use queryAnalyticsExecRaw instead */
export const clickhouseExecRaw = queryAnalyticsExecRaw;
/** @deprecated Use queryAnalyticsStream instead */
export const queryClickhouseStream = queryAnalyticsStream;
