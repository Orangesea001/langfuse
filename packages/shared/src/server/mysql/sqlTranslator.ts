/**
 * Converts ClickHouse-style named parameters {name:Type} to MySQL positional ?.
 *
 * This is a PARAMETER FORMAT CONVERTER, not a SQL translator.
 * All SQL syntax has been directly replaced in the source files;
 * this module only handles the {param:Type} → ? conversion at runtime,
 * since 453+ named parameter references are embedded throughout the codebase.
 *
 * If all {param:Type} are eventually replaced with ? and params are
 * converted to positional arrays, this module can be removed entirely.
 */

/** Result of parameter conversion */
export type TranslatedQuery = {
  sql: string;
  params: unknown[];
};

/**
 * Convert {param:Type} named parameters to MySQL ? positional parameters.
 *
 * @param query - SQL string with {param:Type} placeholders
 * @param namedParams - Object map of parameter values
 * @returns SQL with ? placeholders and ordered params array
 */
export function translateQuery(
  query: string,
  namedParams?: Record<string, unknown>,
): TranslatedQuery {
  if (!namedParams || Object.keys(namedParams).length === 0) {
    // No params - just return the query as-is (no {param:Type} to convert)
    // But check if there are any named params in the query anyway
    if (!/\{\w+:\s*[^}]+\}/.test(query)) {
      return { sql: query, params: [] };
    }
  }

  const params: unknown[] = [];
  const sql = query.replace(
    /\{(\w+):\s*[^}]+\}/g,
    (_match, paramName: string) => {
      if (namedParams && paramName in namedParams) {
        params.push(namedParams[paramName]);
        return "?";
      }
      // Parameter not found in namedParams - leave as-is (will cause MySQL error)
      console.warn(
        `Named parameter {${paramName}:...} not found in params object`,
      );
      return _match;
    },
  );

  return { sql, params };
}

/**
 * Parse ClickHouse UTC datetime format string to a Date object.
 * Preserved for compatibility with existing callers.
 */
export function parseAnalyticsUTCDateTimeFormat(dateTimeStr: string): Date {
  if (!dateTimeStr) return new Date(0);
  const date = new Date(dateTimeStr + "Z");
  return isNaN(date.getTime()) ? new Date(dateTimeStr) : date;
}

/**
 * Convert a Date to MySQL datetime string format.
 */
export function convertDateToMySqlDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}
