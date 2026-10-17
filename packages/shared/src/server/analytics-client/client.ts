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
export type AnalyticsClientType = ReturnType<typeof getMySqlPool>;

export type PreferredAnalyticsService =
  | "ReadWrite"
  | "ReadOnly"
  | "EventsReadOnly";

/** Stub: ClickHouse settings are not applicable to MySQL */

/** Stub: exception tag header not applicable */
export const EXCEPTION_TAG_HEADER_NAME = "x-analytics-exception" as string;

/**
 * AnalyticsClientManager — now a no-op that returns the MySQL pool.
 * Preserved for compatibility with callers that reference this class.
 */
export class AnalyticsClientManager {
  private static instance: AnalyticsClientManager;

  private constructor() {}

  public static getInstance(): AnalyticsClientManager {
    if (!AnalyticsClientManager.instance) {
      AnalyticsClientManager.instance = new AnalyticsClientManager();
    }
    return AnalyticsClientManager.instance;
  }

  public getClient(): AnalyticsClientType {
    return getMySqlPool();
  }

  public closeAllConnections(): Promise<void[]> {
    return closeMySqlPool().then(() => []);
  }
}

/**
 * Returns the MySQL connection pool.
 * Preserved for compatibility: callers use analyticsClient() to get a client.
 */
export const analyticsClient = (): AnalyticsClientType => {
  return AnalyticsClientManager.getInstance().getClient();
};

/**
 * Convert a Date to MySQL datetime string format.
 * Replaces convertDateToAnalyticsDateTime.
 */
export const convertDateToAnalyticsDateTime = (date: Date): string => {
  return date.toISOString().replace("T", " ").replace("Z", "");
};

const DATETIME_STRING = /^\d{4}-\d{2}-\d{2} /;

/**
 * Convert various date formats to MySQL datetime string.
 * Replaces toAnalyticsDateTime.
 */
export const toAnalyticsDateTime = (
  value?: Date | number | string | null,
): string => {
  if (value == null) {
    return convertDateToAnalyticsDateTime(new Date());
  }
  if (value instanceof Date) {
    return convertDateToAnalyticsDateTime(value);
  }
  if (typeof value === "number") {
    return convertDateToAnalyticsDateTime(new Date(value));
  }
  if (DATETIME_STRING.test(value)) {
    return value;
  }
  return convertDateToAnalyticsDateTime(new Date(value));
};
