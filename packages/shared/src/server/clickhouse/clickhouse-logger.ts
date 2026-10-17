/**
 * ClickHouse logger — now a no-op stub for MySQL.
 * Preserved for compatibility with imports.
 */
import { logger as winstonLogger } from "../logger";

/** No-op logger class that satisfies the @clickhouse/client Logger interface */
export class ClickHouseLogger {
  trace(_message: string) {}
  debug(_message: string) {}
  info(_message: string) {}
  warn(_message: string) {}
  error(_message: string) {}
}

/** Map Langfuse log level to ClickHouse log level (no-op) */
export const mapLogLevel = (level?: string): string => {
  return level ?? "info";
};
