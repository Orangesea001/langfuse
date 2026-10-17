/**
 * Zebra Proxy integration for Meituan internal deployment.
 *
 * This module provides Zebra-aware MySQL connection configuration,
 * following the same pattern as aip's ext_database.py and zebra_utils.py.
 *
 * aip's Python pattern:
 *   ZebraConfig(appname=get_app_key(), ref_key="bjintel_aip_product")
 *   hack_flask_sqlalchemy(db, ZebraConfig(...))
 *   engine = zebra_create_engine(config, connect_args={...}, pool_recycle=3600)
 *
 * Langfuse's TypeScript equivalent:
 *   const config = resolveZebraConfig();
 *   // → { uri: "mysql://appname@zebra-host:3306/ref_key", ... }
 *
 * ref_key mapping (environment-based):
 *   PRODUCTION  → bjintel_langfuse_product
 *   STAGING     → bjintel_langfuse_staging
 *   TEST        → bjintel_langfuse_test
 *   DEVELOPMENT → bjintel_langfuse_dev
 *
 * Connection flow:
 *   App → Zebra Proxy → RDS MySQL 8.0
 *
 * Connection pool defaults (matching aip's zebra_utils.py):
 *   connect_timeout:  2s
 *   read_timeout:    20s
 *   pool_recycle:  3600s (1 hour)
 *   charset:       utf8mb4
 */

import { env } from "../../env";
import { logger } from "../logger";

/** Deployment environments (mirrors aip's DEPLOY_ENV pattern) */
export type DeployEnv = "PRODUCTION" | "STAGING" | "TEST" | "DEVELOPMENT";

/** ref_key mapping: environment → Zebra config center key */
export const REF_KEY_MAP: Record<DeployEnv, string> = {
  PRODUCTION: "bjintel_langfuse_product",
  STAGING: "bjintel_langfuse_staging",
  TEST: "bjintel_langfuse_test",
  DEVELOPMENT: "bjintel_langfuse_dev",
};

/** Default Zebra Proxy connection parameters (matching aip's zebra_utils.py) */
export const ZEBRA_DEFAULTS = {
  /** Connection timeout in ms (aip: 2s) */
  connectTimeout: 2_000,
  /** Read timeout in ms (aip: 20s) */
  readTimeout: 20_000,
  /** Pool recycle time in seconds (aip: 3600s = 1 hour) */
  poolRecycle: 3_600,
  /** Character set (aip: utf8, we use utf8mb4 for full Unicode) */
  charset: "utf8mb4" as const,
  /** Default Zebra Proxy host */
  proxyHost: "zebra-proxy.internal",
  /** Default app name in MCC config center */
  appName: "com.sankuai.t0.langfuse",
};

/**
 * Resolve the ref_key for the current deployment environment.
 *
 * Priority:
 *  1. LANGFUSE_ZEBRA_REF_KEY env var (explicit override)
 *  2. DEPLOY_ENV env var → REF_KEY_MAP lookup
 *  3. Default: DEVELOPMENT → bjintel_langfuse_dev
 */
export function resolveRefKey(): string {
  // Priority 1: Explicit ref_key
  if (env.LANGFUSE_ZEBRA_REF_KEY) {
    return env.LANGFUSE_ZEBRA_REF_KEY;
  }

  // Priority 2: Map from DEPLOY_ENV
  const deployEnv = env.DEPLOY_ENV;
  const refKey = REF_KEY_MAP[deployEnv];
  if (refKey) {
    logger.info("Zebra ref_key resolved from DEPLOY_ENV", {
      deployEnv,
      refKey,
    });
    return refKey;
  }

  // Priority 3: Default
  const defaultRefKey = REF_KEY_MAP.DEVELOPMENT;
  logger.warn("Unknown DEPLOY_ENV, defaulting to DEVELOPMENT", {
    deployEnv,
    defaultRefKey,
  });
  return defaultRefKey;
}

/**
 * Resolve full Zebra Proxy connection URI.
 *
 * Format: mysql://appname@proxyhost:3306/ref_key
 * The Zebra Proxy intercepts this connection and routes to the
 * actual MySQL instance based on the ref_key configuration.
 */
export function resolveZebraUri(): string | null {
  const refKey = resolveRefKey();
  if (!refKey) return null;

  const appName = env.LANGFUSE_ZEBRA_APP_NAME || ZEBRA_DEFAULTS.appName;
  const proxyHost = env.LANGFUSE_ZEBRA_PROXY_HOST || ZEBRA_DEFAULTS.proxyHost;

  const uri = `mysql://${appName}@${proxyHost}:3306/${refKey}`;
  logger.info("Zebra Proxy URI resolved", { appName, proxyHost, refKey });
  return uri;
}

/**
 * Get Zebra-aware MySQL pool options.
 * Includes aip-compatible timeout and pool settings.
 */
export function getZebraPoolOptions(): {
  connectTimeout: number;
  readTimeout: number;
  poolRecycle: number;
  charset: string;
} {
  return {
    connectTimeout: ZEBRA_DEFAULTS.connectTimeout,
    readTimeout: ZEBRA_DEFAULTS.readTimeout,
    poolRecycle: ZEBRA_DEFAULTS.poolRecycle,
    charset: ZEBRA_DEFAULTS.charset,
  };
}
