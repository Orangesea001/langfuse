/* eslint-disable @repo/no-exotic-operators */
/**
 * Analytics store writer — now backed by MySQL instead of ClickHouse.
 *
 * Replaces the ClickhouseWriter with MySqlWriter that uses
 * INSERT ... ON DUPLICATE KEY UPDATE for upserts.
 */
import {
  BlobStorageFileLogInsertType,
  getCurrentSpan,
  ObservationRecordInsertType,
  ObservationBatchStagingRecordInsertType,
  recordDistribution,
  recordGauge,
  recordHistogram,
  recordIncrement,
  ScoreRecordInsertType,
  TraceRecordInsertType,
  TraceNullRecordInsertType,
  DatasetRunItemRecordInsertType,
  EventRecordInsertType,
  buildClickHouseLogComment,
} from "@langfuse/shared/src/server";

import { Decimal } from "decimal.js";

import { env } from "../../env";
import { logger } from "@langfuse/shared/src/server";
import { instrumentAsync } from "@langfuse/shared/src/server";
import { backOff } from "exponential-backoff";
import { getMySqlPool } from "@langfuse/shared/src/server/mysql/client";
import { convertDateToMySqlDateTime } from "@langfuse/shared/src/server/mysql/sqlTranslator";

// Decimal64(12): valid range is (-10^6, 10^6), i.e. 18 total digits with 12 fractional.
const DECIMAL_64_12_LIMIT = new Decimal("1e6");
const DECIMAL_64_12_MAX_NUM = 999_999.999_999;
const DECIMAL_64_12_MIN_NUM = -DECIMAL_64_12_MAX_NUM;
const MULTI_PROJECT_LOG_COMMENT_PROJECT_ID = "MULTI_PROJECT";

export class ClickhouseWriter {
  private static instance: ClickhouseWriter | null = null;
  batchSize: number;
  writeInterval: number;
  maxAttempts: number;
  queue: ClickhouseQueue;

  isIntervalFlushInProgress: boolean;
  intervalId: NodeJS.Timeout | null = null;

  private constructor() {
    this.batchSize = env.LANGFUSE_INGESTION_CLICKHOUSE_WRITE_BATCH_SIZE;
    this.writeInterval = env.LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS;
    this.maxAttempts = env.LANGFUSE_INGESTION_CLICKHOUSE_MAX_ATTEMPTS;

    this.isIntervalFlushInProgress = false;

    this.queue = {
      [TableName.Traces]: [],
      [TableName.TracesNull]: [],
      [TableName.Scores]: [],
      [TableName.Observations]: [],
      [TableName.ObservationsBatchStaging]: [],
      [TableName.BlobStorageFileLog]: [],
      [TableName.DatasetRunItems]: [],
      [TableName.EventsFull]: [],
    };

    this.start();
  }

  /**
   * Get the singleton instance of ClickhouseWriter.
   */
  public static getInstance() {
    if (!ClickhouseWriter.instance) {
      ClickhouseWriter.instance = new ClickhouseWriter();
    }
    return ClickhouseWriter.instance;
  }

  private start() {
    logger.info(
      `Starting ClickhouseWriter (MySQL backend). Max interval: ${this.writeInterval} ms, Max batch size: ${this.batchSize}`,
    );

    this.intervalId = setInterval(() => {
      if (this.isIntervalFlushInProgress) return;

      this.isIntervalFlushInProgress = true;

      this.flushAll().finally(() => {
        this.isIntervalFlushInProgress = false;
      });
    }, this.writeInterval);
  }

  public async shutdown(): Promise<void> {
    logger.info("Shutting down ClickhouseWriter (MySQL backend)…");

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    await this.flushAll(true);

    logger.info("ClickhouseWriter shutdown complete.");
  }

  public async flushAll(fullQueue = false) {
    return instrumentAsync(
      {
        name: "write-to-analytics-store",
      },
      async () => {
        recordIncrement("langfuse.queue.clickhouse_writer.request");
        await Promise.all([
          this.flush(TableName.Traces, fullQueue),
          this.flush(TableName.TracesNull, fullQueue),
          this.flush(TableName.Scores, fullQueue),
          this.flush(TableName.Observations, fullQueue),
          this.flush(TableName.ObservationsBatchStaging, fullQueue),
          this.flush(TableName.BlobStorageFileLog, fullQueue),
          this.flush(TableName.DatasetRunItems, fullQueue),
          this.flush(TableName.EventsFull, fullQueue),
        ]).catch((err) => {
          logger.error("ClickhouseWriter.flushAll", err);
        });
      },
    );
  }

  private isRetryableError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const errorMessage = (error as Error).message?.toLowerCase() || "";
    return (
      errorMessage.includes("socket hang up") ||
      errorMessage.includes("timeout error") ||
      errorMessage.includes("econnreset") ||
      errorMessage.includes("econnrefused") ||
      errorMessage.includes("deadlock") ||
      errorMessage.includes("lock wait timeout")
    );
  }

  private isSizeError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const errorMessage = (error as Error).message?.toLowerCase() || "";
    return (
      errorMessage.includes("size of json object") ||
      errorMessage.includes("too many rows") ||
      errorMessage.includes("packet too large")
    );
  }

  private isStringLengthError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const errorMessage = (error as Error).message?.toLowerCase() || "";
    return errorMessage.includes("invalid string length");
  }

  private handleStringLengthError<T extends TableName>(
    tableName: T,
    queueItems: ClickhouseWriterQueueItem<T>[],
  ): {
    retryItems: ClickhouseWriterQueueItem<T>[];
    requeueItems: ClickhouseWriterQueueItem<T>[];
  } {
    if (queueItems.length === 1) {
      const truncatedRecord = this.truncateOversizedRecord(
        tableName,
        queueItems[0].data,
      );
      logger.warn(
        `String length error with single record for ${tableName}, falling back to truncation`,
        { recordId: queueItems[0].data.id },
      );
      return {
        retryItems: [{ ...queueItems[0], data: truncatedRecord }],
        requeueItems: [],
      };
    }

    const splitPoint = Math.floor(queueItems.length / 2);
    const retryItems = queueItems.slice(0, splitPoint);
    const requeueItems = queueItems.slice(splitPoint);

    logger.info(
      `Splitting batch for ${tableName} due to string length error. Retrying ${retryItems.length}, requeueing ${requeueItems.length}`,
    );

    return { retryItems, requeueItems };
  }

  private truncateOversizedRecord<T extends TableName>(
    tableName: T,
    record: RecordInsertType<T>,
  ): RecordInsertType<T> {
    const maxFieldSize = 1024 * 1024;
    const truncationMessage = "[TRUNCATED: Field exceeded size limit]";

    const truncateField = (value: string | null | undefined): string | null => {
      if (!value) return value || null;
      if (value.length > maxFieldSize) {
        return value.substring(0, 500 * 1024) + truncationMessage;
      }
      return value;
    };

    if (
      "input" in record &&
      record.input &&
      record.input.length > maxFieldSize
    ) {
      record.input = truncateField(record.input);
    }

    if (
      "output" in record &&
      record.output &&
      record.output.length > maxFieldSize
    ) {
      record.output = truncateField(record.output);
    }

    if ("metadata" in record && record.metadata) {
      const metadata = record.metadata;
      const truncatedMetadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(metadata)) {
        if (value && value.length > maxFieldSize) {
          truncatedMetadata[key] = truncateField(value) || "";
        } else {
          truncatedMetadata[key] = value;
        }
      }
      record.metadata = truncatedMetadata;
    }

    return record;
  }

  private static clampDecimal64Value(value: number): [number, boolean] {
    if (!Number.isFinite(value)) return [0, true];
    if (new Decimal(value).abs().gte(DECIMAL_64_12_LIMIT)) {
      return [value >= 0 ? DECIMAL_64_12_MAX_NUM : DECIMAL_64_12_MIN_NUM, true];
    }
    return [value, false];
  }

  private clampDecimal64Map(
    map: Record<string, number> | undefined,
    context: { recordId: string; projectId: string; fieldName: string },
  ): Record<string, number> | undefined {
    if (!map) return map;

    let result: Record<string, number> | undefined;
    for (const [key, value] of Object.entries(map)) {
      const [cv, wasClamped] = ClickhouseWriter.clampDecimal64Value(value);
      if (wasClamped) {
        result ??= { ...map };
        result[key] = cv;
      }
    }
    if (!result) return map;

    logger.warn("Clamped Decimal64(12) overflow in cost map", {
      projectId: context.projectId,
      recordId: context.recordId,
      fieldName: context.fieldName,
    });
    recordIncrement("langfuse.clickhouse_writer.decimal64_clamped");
    return result;
  }

  private clampDecimal64Fields<T extends TableName>(
    tableName: T,
    record: RecordInsertType<T>,
  ): RecordInsertType<T> {
    const r = record as Record<string, unknown>;
    const ctx = {
      recordId: r.id as string,
      projectId: r.project_id as string,
    };

    switch (tableName) {
      case TableName.Observations:
      case TableName.ObservationsBatchStaging:
      case TableName.EventsFull: {
        r.provided_cost_details = this.clampDecimal64Map(
          r.provided_cost_details as Record<string, number> | undefined,
          { ...ctx, fieldName: "provided_cost_details" },
        );
        r.cost_details = this.clampDecimal64Map(
          r.cost_details as Record<string, number> | undefined,
          { ...ctx, fieldName: "cost_details" },
        );
        if (r.total_cost != null && typeof r.total_cost === "number") {
          const [cv, wasClamped] = ClickhouseWriter.clampDecimal64Value(
            r.total_cost,
          );
          if (wasClamped) {
            r.total_cost = cv;
            logger.warn("Clamped Decimal64(12) overflow in total_cost", {
              projectId: ctx.projectId,
              recordId: ctx.recordId,
              fieldName: "total_cost",
            });
            recordIncrement("langfuse.clickhouse_writer.decimal64_clamped");
          }
        }
        break;
      }
    }

    return record;
  }

  private async flush<T extends TableName>(tableName: T, fullQueue = false) {
    const entityQueue = this.queue[tableName];
    if (entityQueue.length === 0) return;

    let queueItems = entityQueue.splice(
      0,
      fullQueue ? entityQueue.length : this.batchSize,
    );

    queueItems.forEach((item) => {
      const waitTime = Date.now() - item.createdAt;
      recordHistogram("langfuse.queue.clickhouse_writer.wait_time", waitTime, {
        unit: "milliseconds",
      });
      recordDistribution(
        "langfuse.queue.clickhouse_writer.time_distribution",
        waitTime,
        { entity_type: tableName, type: "wait", unit: "milliseconds" },
      );
    });

    const currentSpan = getCurrentSpan();
    if (currentSpan) {
      currentSpan.setAttributes({ [`${tableName}-length`]: queueItems.length });
    }

    try {
      const processingStartTime = Date.now();

      let recordsToWrite = queueItems.map((item) => item.data);
      recordsToWrite = recordsToWrite.map((r) =>
        this.clampDecimal64Fields(tableName, r),
      );
      let hasBeenTruncated = false;

      await backOff(
        async () =>
          this.writeToMySql({
            table: tableName,
            records: recordsToWrite,
          }),
        {
          numOfAttempts: env.LANGFUSE_INGESTION_CLICKHOUSE_MAX_ATTEMPTS,
          retry: (error: Error, attemptNumber: number) => {
            const isRetryable = this.isRetryableError(error);
            const isSizeErr = this.isSizeError(error);
            const isStringLengthErr = this.isStringLengthError(error);

            if (isRetryable) {
              logger.warn(
                `Writer failed with retryable error for ${tableName} (attempt ${attemptNumber}): ${error.message}`,
                { error: error.message, attemptNumber },
              );
              return true;
            } else if (isStringLengthErr) {
              logger.warn(
                `Writer failed with string length error for ${tableName} (attempt ${attemptNumber}): Splitting batch`,
                {
                  error: error.message,
                  attemptNumber,
                  batchSize: queueItems.length,
                },
              );

              const { retryItems, requeueItems } = this.handleStringLengthError(
                tableName,
                queueItems,
              );
              recordsToWrite = retryItems.map((item) => item.data);
              queueItems = retryItems;

              if (requeueItems.length > 0) {
                entityQueue.unshift(...requeueItems);
              }
              return true;
            } else if (isSizeErr && !hasBeenTruncated) {
              logger.warn(
                `Writer failed with size error for ${tableName} (attempt ${attemptNumber}): Truncating and retrying`,
                { error: error.message, attemptNumber },
              );
              recordsToWrite = recordsToWrite.map((record) =>
                this.truncateOversizedRecord(tableName, record),
              );
              hasBeenTruncated = true;
              return true;
            }

            logger.error(
              `Write failed with non-retryable error: ${error.message}`,
              { error: error.message },
            );
            return false;
          },
          startingDelay: 100,
          timeMultiple: 1,
          maxDelay: 100,
        },
      );

      const processingTime = Date.now() - processingStartTime;
      recordHistogram(
        "langfuse.queue.clickhouse_writer.processing_time",
        processingTime,
        { unit: "milliseconds" },
      );
      recordDistribution(
        "langfuse.queue.clickhouse_writer.time_distribution",
        processingTime,
        {
          entity_type: tableName,
          type: "processing",
          unit: "milliseconds",
        },
      );

      logger.debug(
        `Flushed ${queueItems.length} records to MySQL ${tableName}. New queue length: ${entityQueue.length}`,
      );

      recordGauge(
        "ingestion_clickhouse_insert_queue_length",
        entityQueue.length,
        { unit: "records", entityType: tableName },
      );
    } catch (err) {
      logger.error(`ClickhouseWriter.flush ${tableName}`, err);

      let droppedCount = 0;
      queueItems.forEach((item) => {
        if (item.attempts < this.maxAttempts) {
          entityQueue.push({ ...item, attempts: item.attempts + 1 });
        } else {
          recordIncrement("langfuse.queue.clickhouse_writer.error");
          droppedCount++;
        }
      });

      if (droppedCount > 0) {
        recordIncrement(
          "langfuse.queue.clickhouse_writer.rows_dropped",
          droppedCount,
          { entity_type: tableName },
        );
        const droppedIds = queueItems
          .filter((item) => item.attempts >= this.maxAttempts)
          .map((item) => {
            const r = item.data as Record<string, unknown>;
            return {
              project_id: r.project_id,
              trace_id: r.trace_id ?? r.id,
              id: r.id,
            };
          });
        logger.error(
          `Max attempts reached, dropped ${droppedCount} ${tableName} record(s)`,
          { droppedIds },
        );
      }
    }
  }

  public addToQueue<T extends TableName>(
    tableName: T,
    data: RecordInsertType<T>,
  ) {
    const entityQueue = this.queue[tableName];
    entityQueue.push({ createdAt: Date.now(), attempts: 1, data });

    if (entityQueue.length >= this.batchSize) {
      logger.debug(`Queue is full. Flushing ${tableName}…`);
      this.flush(tableName).catch((err) => {
        logger.error("ClickhouseWriter.addToQueue flush", err);
      });
    }
  }

  /**
   * Write records to MySQL using INSERT ... ON DUPLICATE KEY UPDATE.
   * Replaces the ClickHouse client insert method.
   */
  private async writeToMySql<T extends TableName>(params: {
    table: T;
    records: RecordInsertType<T>[];
  }): Promise<void> {
    const startTime = Date.now();

    if (params.records.length === 0) return;

    const pool = getMySqlPool();
    const table = String(params.table);

    // MySQL column allowlist based on actual MySQL table schemas
    const mysqlColumns: Record<string, Set<string>> = {
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
        "environment", // removed for MySQL - mapped below
      ]),
      scores: new Set([
        "id",
        "timestamp",
        "trace_id",
        "observation_id",
        "session_id",
        "name",
        "value",
        "source",
        "comment",
        "author_user_id",
        "score_type",
        "data_type",
        "project_id",
        "created_at",
        "updated_at",
        "event_ts",
        "is_deleted",
        "score_config_id",
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
        "environment", // removed for MySQL - mapped below
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
        "environment", // removed for MySQL - mapped below
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
        "environment", // removed for MySQL - mapped below
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
        "environment", // removed for MySQL - mapped below
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
        "provided_usage",
        "provided_usage_details",
        "input_price",
        "output_price",
        "calculated_total_cost",
        "calculated_input_cost",
        "calculated_output_cost",
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
    // ClickHouse -> MySQL column name mapping for tables with different schemas
    const colMapping: Record<string, Record<string, string>> = {
      scores: {
        environment: "data_type",
        score_config_id: "config_id",
      },
      observations: {
        model: "provided_model_name",
        model_id: "internal_model_id",
        model_params: "model_parameters",
        usage: "usage_details",
        provided_usage: "cost_details",
        provided_usage_details: "cost_details",
        public: "status",
        session_id: "metadata",
        latency: "total_cost",
        prompt_tokens: "internal_model_id",
        completion_tokens: "internal_model_id",
        total_tokens: "internal_model_id",
        input_cost: "total_cost",
        output_cost: "total_cost",
        calculated_total_cost: "total_cost",
        calculated_input_cost: "total_cost",
        calculated_output_cost: "total_cost",
        trace_tags: "tags",
        has_input: "input",
        has_output: "output",
      },
      observations_batch_staging: {
        model: "provided_model_name",
        model_id: "internal_model_id",
        model_params: "model_parameters",
        usage: "usage_details",
        provided_usage: "cost_details",
        provided_usage_details: "cost_details",
        public: "status",
        session_id: "metadata",
        latency: "total_cost",
        prompt_tokens: "internal_model_id",
        completion_tokens: "internal_model_id",
        total_tokens: "internal_model_id",
        input_cost: "total_cost",
        output_cost: "total_cost",
        calculated_total_cost: "total_cost",
        calculated_input_cost: "total_cost",
        calculated_output_cost: "total_cost",
        trace_tags: "tags",
        has_input: "input",
        has_output: "output",
      },
    };
    // Primary key columns per table (excluded from ON DUPLICATE KEY UPDATE)
    const pkColumns: Record<string, string[]> = {
      traces: ["id"],
      scores: ["id"],
      observations: ["id"],
      observations_batch_staging: ["id"],
      blob_storage_file_log: ["project_id", "trace_id", "bucket_path"],
      dataset_run_items_rmt: ["id"],
      events_full: ["id"],
    };
    const allowedCols = mysqlColumns[table];
    const pkCols = new Set(pkColumns[table] ?? ["id"]);
    const allRecordKeys = Object.keys(
      params.records[0] as Record<string, unknown>,
    );
    const columns = allowedCols
      ? allRecordKeys.filter((c) => allowedCols.has(c))
      : allRecordKeys;

    // Apply column name mapping for ClickHouse -> MySQL schema differences
    const mapping = colMapping[table] ?? {};
    const mappedColumns = columns.map((c) => mapping[c] ?? c);
    // Deduplicate mapped columns (multiple CH cols may map to same MySQL col)
    const seenCols = new Set<string>();
    const finalColumns: string[] = [];
    for (const c of mappedColumns) {
      if (!seenCols.has(c)) {
        seenCols.add(c);
        finalColumns.push(c);
      }
    }

    const colList = finalColumns.map((c) => escapeId(c)).join(", ");
    const rowPlaceholder = `(${finalColumns.map(() => "?").join(", ")})`;
    const allPlaceholders = params.records.map(() => rowPlaceholder).join(", ");

    // ON DUPLICATE KEY UPDATE: update all columns except primary key columns
    const updateSet = finalColumns
      .filter((c) => !pkCols.has(c))
      .map((c) => `${escapeId(c)} = VALUES(${escapeId(c)})`)
      .join(", ");

    const sql = `INSERT INTO ${escapeId(table)} (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${updateSet}`;

    const allParams: unknown[] = [];
    for (const record of params.records) {
      const rec = record as Record<string, unknown>;
      for (const col of columns) {
        const value = rec[col];
        allParams.push(serializeValue(value));
      }
    }

    await pool.query(sql, allParams);

    logger.debug(`writeToMySql: ${Date.now() - startTime} ms`);
    recordGauge("ingestion_clickhouse_insert", params.records.length);
  }
}

function escapeId(id: string): string {
  return "`" + id.replace(/`/g, "``") + "`";
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return convertDateToMySqlDateTime(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "bigint") return Number(value);
  return value;
}

export enum TableName {
  Traces = "traces",
  TracesNull = "traces_null",
  Scores = "scores",
  Observations = "observations",
  ObservationsBatchStaging = "observations_batch_staging",
  BlobStorageFileLog = "blob_storage_file_log",
  DatasetRunItems = "dataset_run_items_rmt",
  EventsFull = "events_full",
}

type RecordInsertType<T extends TableName> = T extends TableName.Scores
  ? ScoreRecordInsertType
  : T extends TableName.Observations
    ? ObservationRecordInsertType
    : T extends TableName.ObservationsBatchStaging
      ? ObservationBatchStagingRecordInsertType
      : T extends TableName.Traces
        ? TraceRecordInsertType
        : T extends TableName.TracesNull
          ? TraceNullRecordInsertType
          : T extends TableName.BlobStorageFileLog
            ? BlobStorageFileLogInsertType
            : T extends TableName.DatasetRunItems
              ? DatasetRunItemRecordInsertType
              : T extends TableName.EventsFull
                ? EventRecordInsertType
                : never;

type ClickhouseQueue = {
  [T in TableName]: ClickhouseWriterQueueItem<T>[];
};

type ClickhouseWriterQueueItem<T extends TableName> = {
  createdAt: number;
  attempts: number;
  data: RecordInsertType<T>;
};
