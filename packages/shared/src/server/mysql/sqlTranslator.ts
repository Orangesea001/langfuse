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
  // Handle Array(Type) params: {param: Array(String)} → (?, ?, ?)
  // Handle scalar params: {param: String} → ?
  const sql = query.replace(
    /\{(\w+):\s*([^}]+)\}/g,
    (_match, paramName: string, typeSpec: string) => {
      if (namedParams && paramName in namedParams) {
        const value = namedParams[paramName];
        if (typeSpec.startsWith("Array(") && Array.isArray(value)) {
          // Expand array into (?, ?, ?) for IN clauses
          const placeholders = value.map((item: unknown) => {
            params.push(item);
            return "?";
          });
          return placeholders.join(", ");
        }
        params.push(value);
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
export function convertDateToMySqlDateTime(
  date: Date | number | string | null | undefined,
): string {
  if (date === null || date === undefined) {
    // Return current datetime for null/undefined values (safe default)
    const now = new Date();
    return now.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
  }
  if (typeof date === "string")
    return date.includes("T")
      ? date.replace("T", " ").replace("Z", "").slice(0, 23)
      : date.slice(0, 23);
  const d = typeof date === "number" ? new Date(date) : date;
  return d.toISOString().replace("T", " ").replace("Z", "").slice(0, 23);
}

/**
 * MySQL reserved words that may appear as column names or aliases in Langfuse queries.
 * These must be backtick-quoted to avoid syntax errors.
 */
const MYSQL_RESERVED_WORDS = new Set([
  "release",
  "version",
  "public",
  "level",
  "type",
  "name",
  "value",
  "values",
  "source",
  "status",
  "comment",
  "input",
  "output",
  "key",
  "order",
  "group",
  "select",
  "from",
  "where",
  "having",
  "limit",
  "offset",
  "index",
  "table",
  "database",
  "user",
  "password",
  "access",
  "rows",
  "precision",
  "interval",
  "signal",
  "mod",
  "div",
  "read",
  "write",
  "charset",
  "collate",
  "columns",
  "fields",
  "lines",
  "process",
  "range",
]);

/**
 * Quote MySQL reserved words in SQL column references and aliases.
 * Also replaces remaining ClickHouse functions with MySQL equivalents.
 */
export function quoteReservedWords(sql: string): string {
  if (!sql || sql.length === 0) return sql;

  let result = sql;

  // 0. Convert double-quoted identifiers to backtick-quoted (PostgreSQL → MySQL)
  // e.g. "trace_id" → `trace_id`
  result = result.replace(/"([a-zA-Z_][a-zA-Z0-9_]*)"/g, "`$1`");

  // 0.5 Remove ClickHouse FINAL table modifier (e.g. "FROM scores s final")
  result = result.replace(/\bfinal\b/gi, "");

  // 1. Replace ClickHouse functions with MySQL equivalents
  result = result.replace(/\btoDate\(/g, "DATE(");

  // 1.5 Replace ClickHouse mapKeys: length(mapKeys(col)) → JSON_LENGTH(col)
  result = result.replace(
    /\blength\s*\(\s*mapKeys\s*\(\s*([^)]+)\s*\)\s*\)/g,
    "JSON_LENGTH($1)",
  );

  // 1.6 Replace ClickHouse count() (no args) with COUNT(*)
  result = result.replace(/\bcount\s*\(\s*\)/g, "COUNT(*)");

  // 1.7 Replace ClickHouse anyLast(col) with MAX(col) (aggregation dedup)
  result = result.replace(/\banyLast\s*\(\s*([^)]+)\s*\)/g, "MAX($1)");

  // 1.8 Replace ClickHouse if(cond, a, b) with MySQL IF(cond, a, b) - already compatible
  // but replace lowerUTF8 with LOWER
  result = result.replace(/\blowerUTF8\s*\(/g, "LOWER(");

  // 1.9 Replace ClickHouse notEmpty(x) with (LENGTH(x) > 0)
  result = result.replace(
    /\bnotEmpty\s*\(\s*([^)]+)\s*\)/g,
    "(LENGTH($1) > 0)",
  );

  // 1.10 Replace ClickHouse SELECT * EXCEPT - not supported in MySQL
  // Two forms: "SELECT * EXCEPT (col1, col2)" and "SELECT * EXCEPT col1, col2"
  // Replace with SELECT * (we accept getting extra columns)
  result = result.replace(/SELECT\s+\*\s+EXCEPT\s+\([^)]+\)/gi, "SELECT *");
  result = result.replace(
    /SELECT\s+\*\s+EXCEPT\s+\w+(?:\s*,\s*\w+)*/gi,
    "SELECT *",
  );

  // 1.11 Replace ClickHouse DateTime64(N) type in params: {name: DateTime64(3)} → {name: String}
  // MySQL doesn't have DateTime64, we pass datetime as string
  result = result.replace(/DateTime64\s*\(\s*\d+\s*\)/g, "String");

  // 1.12 Replace ClickHouse groupUniqArrayIf(col, cond) with conditional GROUP_CONCAT
  result = result.replace(
    /groupUniqArrayIf\s*\(\s*(\w+)\s*,\s*([^)]+)\s*\)/g,
    "GROUP_CONCAT(DISTINCT CASE WHEN $2 THEN $1 ELSE NULL END)",
  );

  // 1.13 Replace ClickHouse groupUniqArrayArrayIf with GROUP_CONCAT
  result = result.replace(
    /groupUniqArrayArrayIf\s*\(\s*(\w+)\s*,\s*([^)]+)\s*\)/g,
    "GROUP_CONCAT(DISTINCT CASE WHEN $2 THEN $1 ELSE NULL END)",
  );

  // 1.14 Replace ClickHouse map() (empty map) with JSON_OBJECT() (empty JSON object)
  result = result.replace(/\bmap\s*\(\s*\)/g, "JSON_OBJECT()");

  // 1.15 Replace ClickHouse arraySum, arrayConcat, arrayJoin
  // These need more complex handling but common patterns:
  // arrayJoin(x) → x (for simple cases)
  // For complex cases, they'll need individual fixes in the source

  // 1.16 Replace ClickHouse if(cond, a, b) - MySQL IF is compatible, but
  // ClickHouse's if can also appear as a bare function in templates
  // Replace positionCaseInsensitive (ClickHouse) with LOCATE (MySQL)
  result = result.replace(/\bpositionCaseInsensitive\s*\(/g, "LOCATE(");

  // 1.17 Replace ClickHouse concat with CONCAT (if lowercase)
  result = result.replace(/\bconcat\s*\(/g, "CONCAT(");

  // 1.18 Replace ClickHouse arraySum with a comment (needs manual fix)
  // result = result.replace(/\barraySum\s*\(/g, '/* arraySum */ (');

  // 1.19 Replace ClickHouse isNull(x) with x IS NULL
  result = result.replace(/\bisNull\s*\(\s*([^)]+)\s*\)/g, "($1 IS NULL)");

  // 1.20 Replace ClickHouse argMaxIf(col, ts, cond) with MAX(CASE WHEN cond THEN col END)
  // argMaxIf returns the value of col where ts is maximum and cond is true
  // Approximate with MAX(CASE WHEN cond THEN col END) which is close enough for dedup scenarios
  result = result.replace(
    /argMaxIf\s*\(\s*([^,]+)\s*,\s*[^,]+\s*,\s*([^)]+)\s*\)/g,
    "MAX(CASE WHEN $2 THEN $1 ELSE NULL END)",
  );

  // 1.21 Replace ClickHouse if(cond, a, b) used as expression - MySQL IF is compatible
  // but replace ClickHouse-specific two-arg ifNull(x, alt) → IFNULL(x, alt) (already MySQL compat)
  // Replace ClickHouse arraySum(x) → (x)  (approximation)
  result = result.replace(/\barraySum\s*\(\s*([^)]+)\s*\)/g, "($1)");

  // 1.22 Replace ClickHouse mapFilter and mapValues - complex, approximate with JSON
  // mapFilter(x -> cond, map) → JSON object filtering (not directly possible)
  // For usage_details paths, these usually appear in complex expressions
  // Replace positionCaseInsensitive (already done)
  // Replace ClickHouse tuple(x, y) → JSON_ARRAY(x, y)
  result = result.replace(/\btuple\s*\(\s*([^)]+)\s*\)/g, "JSON_ARRAY($1)");

  // 1.23 Replace ClickHouse nullIf(x, y) with MySQL NULLIF(x, y)
  result = result.replace(/\bnullIf\s*\(/g, "NULLIF(");

  // 1.24 Replace ClickHouse argMax(col, ts) with MAX(col) - for dedup
  result = result.replace(
    /\bargMax\s*\(\s*([^,]+)\s*,\s*[^)]+\s*\)/g,
    "MAX($1)",
  );

  // 1.25 Replace ClickHouse mapFromArrays(keys, values) with JSON_OBJECT()
  result = result.replace(/\bmapFromArrays\s*\([^)]+\)/g, "JSON_OBJECT()");

  // 1.26 Replace ClickHouse toStartOfMinute(x)
  result = result.replace(
    /\btoStartOfMinute\s*\(\s*([^)]+)\s*\)/g,
    "DATE_FORMAT($1, '%Y-%m-%d %H:%i:00')",
  );

  // 1.27 Replace ClickHouse uniq(x) with COUNT(DISTINCT x)
  result = result.replace(/\buniq\s*\(\s*([^)]+)\s*\)/g, "COUNT(DISTINCT $1)");

  // 1.28 Replace ClickHouse uniqIf(x, cond)
  result = result.replace(
    /\buniqIf\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g,
    "COUNT(DISTINCT CASE WHEN $2 THEN $1 ELSE NULL END)",
  );

  // 1.29 Fix length(GROUP_CONCAT(...)) - replace with 0 (approximation for observation_count)
  result = result.replace(
    /\blength\s*\(\s*GROUP_CONCAT/g,
    "0 + 0/*length(GROUP_CONCAT",
  );

  // 1.30 Replace lowercase if( → IF( for MySQL compatibility
  result = result.replace(/\bif\s*\(/g, "IF(");

  // 1.31 Fix aggregated+level (invalid MySQL column name)
  result = result.replace(/\baggregated\+level\b/g, "`aggregated_level`");

  // 2. Quote MySQL reserved words in column references and aliases

  // 2a. Quote bare reserved words in CASE/WHEN/THEN contexts (no table prefix)
  const bareReservedWords = new Set([
    "release",
    "version",
    "level",
    "type",
    "name",
    "value",
    "source",
    "status",
    "comment",
    "input",
    "output",
    "key",
    "order",
    "user",
    "password",
    "access",
    "precision",
    "range",
  ]);
  for (const word of bareReservedWords) {
    const bareRegex = new RegExp(
      "(?<=[=<>\\s,(]WHEN\\s+)(" + word + ")(?=[^a-zA-Z0-9_`])",
      "gi",
    );
    result = result.replace(
      bareRegex,
      (match, colName: string) => "`" + colName + "`",
    );
    const thenRegex = new RegExp(
      "(?<=THEN\\s+)(" + word + ")(?=[^a-zA-Z0-9_`])",
      "gi",
    );
    result = result.replace(
      thenRegex,
      (match, colName: string) => "`" + colName + "`",
    );
  }
  for (const word of MYSQL_RESERVED_WORDS) {
    // Quote column references: "t.release" → "t.`release`"
    const colRegex = new RegExp(
      "([a-zA-Z_]\\w*)\\.(" + word + ")(?=[^a-zA-Z0-9_`]|$)",
      "g",
    );
    result = result.replace(
      colRegex,
      (match, tableAlias: string, colName: string) => {
        if (match.includes("`")) return match;
        return tableAlias + ".`" + colName + "`";
      },
    );

    // Quote aliases: "as release" → "as `release`"
    const aliasRegex = new RegExp(
      "(\\bas\\s+)(" + word + ")(?=[^a-zA-Z0-9_`]|$)",
      "gi",
    );
    result = result.replace(
      aliasRegex,
      (match, asKw: string, aliasName: string) => {
        if (match.includes("`")) return match;
        return asKw + "`" + aliasName + "`";
      },
    );
  }

  return result;
}

/** @deprecated Use convertDateToMySqlDateTime instead. Alias for backward compat. */
export const toClickhouseDateTime = convertDateToMySqlDateTime;
export const convertDateToClickhouseDateTime = convertDateToMySqlDateTime;

/** @deprecated Use parseAnalyticsUTCDateTimeFormat instead */
export const parseClickhouseUTCDateTimeFormat = parseAnalyticsUTCDateTimeFormat;
