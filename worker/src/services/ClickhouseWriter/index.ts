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
    const columns = Object.keys(params.records[0] as Record<string, unknown>);
    const colList = columns.map((c) => escapeId(c)).join(", ");
    const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
    const allPlaceholders = params.records.map(() => rowPlaceholder).join(", ");

    // ON DUPLICATE KEY UPDATE: update all columns except primary key columns
    const updateSet = columns
      .filter((c) => c !== "id" && c !== "span_id")
      .map((c) => `${escapeId(c)} = VALUES(${escapeId(c)})`)
      .join(", ");

    const sql = `INSERT INTO ${escapeId(table)} (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${updateSet}`;

    const allParams: unknown[] = [];
    for (const record of params.records) {
      for (const col of columns) {
        const value = (record as Record<string, unknown>)[col];
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
  Traces = "trace",
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
