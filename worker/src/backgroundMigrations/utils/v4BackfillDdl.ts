import { env } from "../../env";
import {
  qualifiedClickhouseTableName,
  quoteClickhouseIdentifier,
} from "../../utils/clickhouseIdentifiers";

/**
 * Scratch table for V4 backfill operations.
 */
export const PID_TID_SORTING_TABLE = "observations_pid_tid_sorting";

/**
 * DDL target configuration — simplified for MySQL.
 * MySQL does not have clusters or ON CLUSTER clauses.
 */
export interface ClickhouseDdlTarget {
  database: string;
  clusterEnabled: boolean;
  clusterName: string;
}

function clickhouseDdlTarget(): ClickhouseDdlTarget {
  return {
    database: env.CLICKHOUSE_DB || "langfuse",
    clusterEnabled: false,
    clusterName: "default",
  };
}

/**
 * MySQL does not have ON CLUSTER — always returns empty string.
 */
export function onClusterClause(
  _target: ClickhouseDdlTarget = clickhouseDdlTarget(),
): string {
  return "";
}

/** The scratch table, qualified with the configured database. */
export function pidTidSortingTable(
  target: ClickhouseDdlTarget = clickhouseDdlTarget(),
): string {
  return qualifiedClickhouseTableName(target.database, PID_TID_SORTING_TABLE);
}

function joinSql(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(" ");
}

// ============================================================================
// Merge control (M2) — MySQL stubs
// ============================================================================

/**
 * MySQL does not have merge control. Returns a no-op comment.
 */
export function buildDisableSharedMergeTreeMergesQuery(
  _target: ClickhouseDdlTarget = clickhouseDdlTarget(),
): string {
  return "-- MySQL: no merge control needed";
}

/**
 * MySQL does not have SYSTEM STOP MERGES. Returns a no-op comment.
 */
export function buildStopMergesQuery(
  _target: ClickhouseDdlTarget = clickhouseDdlTarget(),
): string {
  return "-- MySQL: no merge control needed";
}

/**
 * MySQL does not have replicated merge control. Returns a no-op comment.
 */
export function buildFreezeReplicatedMergesQuery(
  _target: ClickhouseDdlTarget = clickhouseDdlTarget(),
): string {
  return "-- MySQL: no merge control needed";
}

/**
 * MySQL does not have SYNC REPLICA. Returns a no-op comment.
 */
export function buildSyncReplicaQuery(
  _target: ClickhouseDdlTarget = clickhouseDdlTarget(),
): string {
  return "-- MySQL: no replica sync needed";
}

// ============================================================================
// Cleanup (M5)
// ============================================================================

/**
 * DROP TABLE IF EXISTS — MySQL compatible.
 */
export function buildDropScratchTableQuery(
  table: string,
  target: ClickhouseDdlTarget = clickhouseDdlTarget(),
): string {
  return joinSql(
    "DROP TABLE IF EXISTS",
    qualifiedClickhouseTableName(target.database, table),
  );
}
