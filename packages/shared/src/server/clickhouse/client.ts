/**
 * Analytics store client — now backed by MySQL.
 *
 * This module preserves the original export signatures from the ClickHouse client
 * but delegates to the MySQL connection pool. All ClickHouse-specific types are
 * stubbed for compatibility.
 */
import { getMySqlPool, closeMySqlPool } from "../mysql/client";
import { env } from "../../env";

/** Stub: no longer a ClickHouse client type */
export type ClickhouseClientType = ReturnType<typeof getMySqlPool>;

export type PreferredClickhouseService =
  | "ReadWrite"
  | "ReadOnly"
  | "EventsReadOnly";

/** Stub: ClickHouse settings are not applicable to MySQL */

/** Stub: exception tag header not applicable */
export const EXCEPTION_TAG_HEADER_NAME = "x-clickhouse-exception" as string;

/**
 * ClickHouseClientManager — now a no-op that returns the MySQL pool.
 * Preserved for compatibility with callers that reference this class.
 */
export class ClickHouseClientManager {
  private static instance: ClickHouseClientManager;

  private constructor() {}

  public static getInstance(): ClickHouseClientManager {
    if (!ClickHouseClientManager.instance) {
      ClickHouseClientManager.instance = new ClickHouseClientManager();
    }
    return ClickHouseClientManager.instance;
  }

  public getClient(): ClickhouseClientType {
    return getMySqlPool();
  }

  public closeAllConnections(): Promise<void[]> {
    return closeMySqlPool().then(() => []);
  }
}

/**
 * Returns the MySQL connection pool.
 * Preserved for compatibility: callers use clickhouseClient() to get a client.
 */
export const clickhouseClient = (): ClickhouseClientType => {
  return ClickHouseClientManager.getInstance().getClient();
};

/**
 * Convert a Date to MySQL datetime string format.
 * Replaces convertDateToClickhouseDateTime.
 */
export const convertDateToClickhouseDateTime = (date: Date): string => {
  return date.toISOString().replace("T", " ").replace("Z", "");
};

const DATETIME_STRING = /^\d{4}-\d{2}-\d{2} /;

/**
 * Convert various date formats to MySQL datetime string.
 * Replaces toClickhouseDateTime.
 */
export const toClickhouseDateTime = (
  value?: Date | number | string | null,
): string => {
  if (value == null) {
    return convertDateToClickhouseDateTime(new Date());
  }
  if (value instanceof Date) {
    return convertDateToClickhouseDateTime(value);
  }
  if (typeof value === "number") {
    return convertDateToClickhouseDateTime(new Date(value));
  }
  if (DATETIME_STRING.test(value)) {
    return value;
  }
  return convertDateToClickhouseDateTime(new Date(value));
};
