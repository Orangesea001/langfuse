import mysql, {
  type PoolOptions,
  type Pool,
  type RowDataPacket,
  type ResultSetHeader,
} from "mysql2/promise";

export type FieldInfo = {
  type: string;
  string: () => string;
};

/**
 * MySQL connection pool for replacing ClickHouse as the analytics store.
 */
import { env } from "../../env";
import { logger } from "../logger";

let pool: Pool | null = null;

export function getMySqlPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      uri: env.LANGFUSE_MYSQL_URL,
      waitForConnections: true,
      connectionLimit: env.LANGFUSE_MYSQL_CONNECTION_LIMIT ?? 25,
      queueLimit: 0,
      timezone: "+00:00",
      dateStrings: true,
    } as PoolOptions);

    logger.info("MySQL pool created", {
      url: env.LANGFUSE_MYSQL_URL?.replace(/:[^:@]+@/, ":***@"),
      connectionLimit: env.LANGFUSE_MYSQL_CONNECTION_LIMIT ?? 25,
    });
  }
  return pool;
}

export async function closeMySqlPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info("MySQL pool closed");
  }
}
