/**
 * MySQL batch writer replacing ClickhouseWriter.
 */
import { getMySqlPool } from "./client";
import { logger } from "../logger";

type TableName = string;

export class MySqlWriter {
  private queues: Map<TableName, Map<string, Record<string, unknown>>> =
    new Map();
  private flushSize: number;
  private tables: TableName[];

  constructor(tables: TableName[], flushSize: number = 1000) {
    this.tables = tables;
    this.flushSize = flushSize;
    for (const table of tables) {
      this.queues.set(table, new Map());
    }
  }

  add(table: TableName, record: Record<string, unknown>): void {
    const queue = this.queues.get(table);
    if (!queue) {
      throw new Error(`Unknown table: ${table}`);
    }
    const key = String(record.id ?? record.span_id ?? "");
    queue.set(key, record);
  }

  isFull(): boolean {
    for (const queue of this.queues.values()) {
      if (queue.size >= this.flushSize) return true;
    }
    return false;
  }

  async flushAll(): Promise<void> {
    for (const [table, queue] of this.queues) {
      if (queue.size > 0) {
        await this.flush(table, Array.from(queue.values()));
        queue.clear();
      }
    }
  }

  async flush(
    table: TableName,
    records: Record<string, unknown>[],
  ): Promise<void> {
    if (records.length === 0) return;

    try {
      const pool = getMySqlPool();
      const columns = Object.keys(records[0]);
      const colList = columns.map((c) => this.escapeId(c)).join(", ");
      const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
      const allPlaceholders = records.map(() => rowPlaceholder).join(", ");

      const updateSet = columns
        .filter((c) => c !== "id" && c !== "span_id")
        .map((c) => `${this.escapeId(c)} = VALUES(${this.escapeId(c)})`)
        .join(", ");

      const sql = `INSERT INTO ${this.escapeId(table)} (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${updateSet}`;

      const allParams: unknown[] = [];
      for (const record of records) {
        for (const col of columns) {
          allParams.push(this.serializeValue(record[col]));
        }
      }

      await pool.query(sql, allParams);
      logger.debug(`Flushed ${records.length} rows to MySQL table ${table}`);
    } catch (error) {
      logger.error(`Failed to flush rows to MySQL table ${table}`, error);
      throw error;
    }
  }

  private escapeId(id: string): string {
    return `\`${id.replace(/\`/g, "\`\`")}\``;
  }

  private serializeValue(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === "object") return JSON.stringify(value);
    if (value instanceof Date)
      return value
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "");
    return value;
  }
}
