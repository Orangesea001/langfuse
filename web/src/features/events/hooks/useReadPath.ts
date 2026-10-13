/* eslint-disable no-nested-ternary */
/**
 * The events read path. This deployment runs V4 only (LANGFUSE_MIGRATION_V4_
 * WRITE_MODE=events_only): the legacy V3 read path and its toggle were removed.
 * The hook is kept with its historical shape so existing call sites keep
 * compiling; every value is now hard-wired to the V4 path.
 */
export type ResolvedReadPath = "v3" | "v4";
/** "unknown" = the session has not resolved yet; no versioned fetch may fire. */
export type ReadPath = ResolvedReadPath | "unknown";

export function useReadPath(): {
  readPath: ReadPath;
  isV4: boolean;
  isV3Legacy: boolean;
  isResolved: boolean;
  canToggleV4: boolean;
} {
  return {
    readPath: "v4",
    isV4: true,
    isV3Legacy: false,
    isResolved: true,
    canToggleV4: false,
  };
}
