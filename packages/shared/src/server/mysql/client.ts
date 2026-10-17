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
 *
 * Supports two connection modes:
 * 1. Direct connection via LANGFUSE_MYSQL_URL (local dev, non-Zebra environments)
 * 2. Zebra Proxy connection via LANGFUSE_ZEBRA_REF_KEY (Meituan internal deployment)
 *    - Zebra is the company's database access middleware (RDS platform)
 *    - Uses ref_key pattern: appname + ref_key → config center resolves real connection
 *    - Production: bjintel_langfuse_product, Test: bjintel_langfuse_test
 *    - MySQL 8.0 is the target version (company-wide 5.7→8.0 migration)
 *
 * Zebra connection flow (following aip's pattern):
 *   App → Zebra Proxy → RDS MySQL 8.0
 *
 * ref_key resolution priority:
 *   1. LANGFUSE_ZEBRA_REF_KEY env var (explicit override)
 *   2. DEPLOY_ENV env var → REF_KEY_MAP lookup
 *   3. Default: DEVELOPMENT → bjintel_langfuse_dev
 */
import { env } from "../../env";
import { logger } from "../logger";
import { resolveZebraUri, resolveRefKey } from "./zebra";

let pool: Pool | null = null;

function resolveMySqlConfig(): { uri: string; connectionLimit: number } {
  const connectionLimit = env.LANGFUSE_MYSQL_CONNECTION_LIMIT ?? 25;

  // Priority 1: Direct URL (preferred for local dev and non-Zebra environments)
  // This ensures LANGFUSE_MYSQL_URL always works regardless of DEPLOY_ENV
  if (env.LANGFUSE_MYSQL_URL) {
    logger.info("MySQL pool using direct URL", {
      url: env.LANGFUSE_MYSQL_URL?.replace(/:[^:@]+@/, ":***@"),
      connectionLimit,
    });
    return { uri: env.LANGFUSE_MYSQL_URL, connectionLimit };
  }

  // Priority 2: Zebra Proxy (for Meituan internal deployment)
  // Uses zebra.ts for ref_key resolution with DEPLOY_ENV support
  // Only used when LANGFUSE_MYSQL_URL is not set
  if (env.LANGFUSE_ZEBRA_REF_KEY) {
    const zebraUri = resolveZebraUri();
    if (zebraUri) {
      const refKey = resolveRefKey();
      logger.info("MySQL pool using Zebra Proxy", {
        refKey,
        uri: zebraUri.replace(/@[^@]+@/, "@***@"),
        connectionLimit,
      });
      return { uri: zebraUri, connectionLimit };
    }
  }

  throw new Error(
    "No MySQL connection configured. Set LANGFUSE_MYSQL_URL for direct connection " +
      "or LANGFUSE_ZEBRA_REF_KEY for Zebra Proxy connection.",
  );
}

export function getMySqlPool(): Pool {
  if (!pool) {
    const { uri, connectionLimit } = resolveMySqlConfig();
    pool = mysql.createPool({
      uri,
      waitForConnections: true,
      connectionLimit,
      queueLimit: 0,
      timezone: "+00:00",
      dateStrings: true,
    } as PoolOptions);
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
