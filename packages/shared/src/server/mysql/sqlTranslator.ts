/**
 * Translates ClickHouse SQL dialect to MySQL-compatible SQL.
 *
 * Handles:
 * 1. Named parameters {name:Type} → positional ? with param extraction
 * 2. FINAL keyword removal (ReplacingMergeTree dedup not needed in MySQL)
 * 3. ClickHouse-specific functions → MySQL equivalents
 * 4. ClickHouse-specific syntax → MySQL equivalents
 */

/** Result of translating a CH query to MySQL */
export type TranslatedQuery = {
  sql: string;
  params: unknown[];
};

/**
 * Translate ClickHouse SQL to MySQL SQL.
 *
 * @param chQuery - ClickHouse SQL string with {param:Type} placeholders
 * @param chParams - Object map of parameter values
 * @returns MySQL SQL with ? placeholders and ordered params array
 */
export function translateQuery(
  chQuery: string,
  chParams?: Record<string, unknown>,
): TranslatedQuery {
  let sql = chQuery;
  const params: unknown[] = [];

  // 1. Remove FINAL keyword (MySQL uses transactional reads)
  sql = sql.replace(/\bFINAL\b/g, "");

  // 2. Replace {param:Type} named parameters with ? positional parameters
  // Matches patterns like {projectId:String}, {limit:UInt32}, {fromTime:DateTime64(3)}, etc.
  if (chParams) {
    sql = sql.replace(/\{(\w+):\s*[^}]+\}/g, (_match, paramName: string) => {
      if (paramName in chParams) {
        params.push(chParams[paramName]);
        return "?";
      }
      // Parameter referenced in SQL but not in params map — leave as is
      // (this shouldn't happen in practice)
      return _match;
    });
  }

  // 3. Translate ClickHouse functions to MySQL equivalents
  // toDateTime(x) → x (MySQL implicitly converts strings to datetime)
  sql = sql.replace(/\btoDateTime\(([^)]+)\)/g, "$1");

  // toDateTime64(x, N) → x
  sql = sql.replace(/\btoDateTime64\([^)]+\)/g, (match) => {
    const inner = match.replace(/\btoDateTime64\(([^,]+),\s*\d+\)/, "$1");
    return inner;
  });

  // toDate(x) → DATE(x)
  sql = sql.replace(/\btoDate\(([^)]+)\)/g, "DATE($1)");

  // toYYYYMM(x) → DATE_FORMAT(x, '%Y%m')
  sql = sql.replace(/\btoYYYYMM\(([^)]+)\)/g, "DATE_FORMAT($1, '%Y%m')");

  // toString(x) → CAST(x AS CHAR)
  sql = sql.replace(/\btoString\(([^)]+)\)/g, "CAST($1 AS CHAR)");

  // toFloat64(x) → CAST(x AS DOUBLE)
  sql = sql.replace(/\btoFloat64\(([^)]+)\)/g, "CAST($1 AS DOUBLE)");

  // toInt32(x) → CAST(x AS SIGNED)
  sql = sql.replace(/\btoInt32\(([^)]+)\)/g, "CAST($1 AS SIGNED)");

  // toInt64(x) → CAST(x AS SIGNED)
  sql = sql.replace(/\btoInt64\(([^)]+)\)/g, "CAST($1 AS SIGNED)");

  // has(Array, elem) → JSON_CONTAINS(Array, JSON_QUOTE(elem))
  // Note: MySQL doesn't have native array type, uses JSON
  sql = sql.replace(
    /\bhas\(([^,]+),\s*([^)]+)\)/g,
    "JSON_CONTAINS($1, CAST($2 AS JSON))",
  );

  // arrayElement(arr, idx) → JSON_EXTRACT(arr, CONCAT('$[', idx-1, ']'))
  // This is a rough translation; specific uses may need manual adjustment

  // 4. Remove ClickHouse-specific table engine clauses (shouldn't appear in queries,
  //    but just in case)

  // 5. Replace ClickHouse Map type access patterns
  // map['key'] or; real CH SQL uses mapKeys/mapValues which are already removed

  return { sql, params };
}

/**
 * Parse ClickHouse datetime string format to JavaScript Date.
 * CH returns "2024-01-01 00:00:00.000" format.
 * MySQL returns "2024-01-01 00:00:00" format (with dateStrings: true).
 */
export function parseClickhouseUTCDateTimeFormat(dateStr: string): Date {
  return new Date(`${dateStr.replace(" ", "T")}Z`);
}

/**
 * Convert a JavaScript Date to MySQL datetime string format.
 * Replaces convertDateToClickhouseDateTime.
 */
export function convertDateToMySqlDateTime(date: Date): string {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}
