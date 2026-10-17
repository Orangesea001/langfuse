/**
 * ClickHouse compatibility settings — now a no-op stub.
 *
 * MySQL does not need version-based compatibility settings.
 * This module preserves the export signatures for compatibility.
 */

/** Stub: ClickHouse settings type */

/** Stub: version info */
export type AnalyticsVersion = {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  build: number;
  tuple: readonly [number, number, number, number];
};

/** No-op: returns empty settings for MySQL */
export const getAnalyticsCompatibilitySettings = (): Record<
  string,
  unknown
> => ({});

/** No-op: initialization not needed for MySQL */
export const initializeAnalyticsCompatibility = async (): Promise<void> => {
  // MySQL does not need version-based compatibility initialization
};

/** No-op: returns 'sanitize' as default (unused for MySQL) */
export const getAnalyticsJsonBadUnicodeEscapeMode = () => "sanitize" as const;

/** No-op: resolves to empty settings */
export const resolveAnalyticsCompatibility = () => ({
  settings: {} as Record<string, unknown>,
  appliedRules: [] as unknown[],
  parsedVersion: null as AnalyticsVersion | null,
  flags: [] as unknown[],
});

/** No-op: version parsing */
export const parseAnalyticsVersion = (
  _rawVersion: string,
): AnalyticsVersion | null => null;

/** No-op: version band check */
export const isAnalyticsVersionInBand = (
  _version: string | AnalyticsVersion,
  _band: { minInclusive: string; maxExclusive?: string },
): boolean => false;

/** No-op: resolve JSON bad unicode escape mode */
export const resolveAnalyticsJsonBadUnicodeEscapeMode = () =>
  "sanitize" as const;

/** No-op: set version for tests */
export const setAnalyticsCompatibilityVersionForTests = (
  _version: string | null,
): void => {};
