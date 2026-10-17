/**
 * Query tracking — now backed by MySQL.
 *
 * Preserved for compatibility: exports the same interface.
 */
import { queryAnalytics } from "../repositories";

/**
 * Check if query tracking is enabled.
 * Preserved for compatibility.
 */
export const isQueryTrackingEnabled = (): boolean => {
  return false;
};

/**
 * Get the query tracking table name.
 * Preserved for compatibility.
 */
export const getQueryTrackingTableName = (): string => {
  return "query_tracking";
};
