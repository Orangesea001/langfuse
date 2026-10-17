/**
 * ClickHouse compatibility settings — now a no-op stub.
 *
 * MySQL does not need version-based compatibility settings.
 * This module preserves the export signatures for compatibility.
 */

/** Stub: ClickHouse settings type */

/** Stub: version info */
export type ClickHouseVersion = {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  build: number;
  tuple: readonly [number, number, number, number];
};

/** No-op: returns empty settings for MySQL */
export const getClickHouseCompatibilitySettings = (): Record<
  string,
  unknown
> => ({});

/** No-op: initialization not needed for MySQL */
export const initializeClickhouseCompatibility = async (): Promise<void> => {
  // MySQL does not need version-based compatibility initialization
};

/** No-op: returns 'sanitize' as default (unused for MySQL) */
export const getClickHouseJsonBadUnicodeEscapeMode = () => "sanitize" as const;

/** No-op: resolves to empty settings */
export const resolveClickHouseCompatibility = () => ({
  settings: {} as Record<string, unknown>,
  appliedRules: [] as unknown[],
  parsedVersion: null as ClickHouseVersion | null,
  flags: [] as unknown[],
});

/** No-op: version parsing */
export const parseClickHouseVersion = (
  _rawVersion: string,
): ClickHouseVersion | null => null;

/** No-op: version band check */
export const isClickHouseVersionInBand = (
  _version: string | ClickHouseVersion,
  _band: { minInclusive: string; maxExclusive?: string },
): boolean => false;

/** No-op: resolve JSON bad unicode escape mode */
export const resolveClickHouseJsonBadUnicodeEscapeMode = () =>
  "sanitize" as const;

/** No-op: set version for tests */
export const setClickHouseCompatibilityVersionForTests = (
  _version: string | null,
): void => {};
