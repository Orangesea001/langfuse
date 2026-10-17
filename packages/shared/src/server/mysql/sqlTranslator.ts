/**
 * Translates ClickHouse SQL dialect to MySQL-compatible SQL.
 *
 * Handles:
 * 1. Named parameters {name:Type} → positional ? with param extraction
 * 2. FINAL keyword removal (ReplacingMergeTree dedup not needed in MySQL)
 * 3. ClickHouse-specific functions → MySQL equivalents
 * 4. ClickHouse-specific syntax → MySQL equivalents
 * 5. SETTINGS clause removal
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

  // 2. Remove SETTINGS clause (e.g., "SETTINGS use_query_cache = false")
  sql = sql.replace(/\bSETTINGS\s+[^;]*?(?=\s*;?\s*$|\s*\))/gi, "");

  // 3. Replace {param:Type} named parameters with ? positional parameters
  // Matches patterns like {projectId:String}, {limit:UInt32}, {fromTime:DateTime64(3)}, etc.
  if (chParams) {
    sql = sql.replace(/\{(\w+):\s*[^}]+\}/g, (_match, paramName: string) => {
      if (paramName in chParams) {
        params.push(chParams[paramName]);
        return "?";
      }
      return _match;
    });
  }

  // 4. Translate ClickHouse functions to MySQL equivalents
  // Order matters: more specific patterns first

  // toDateTime64(x, N) → x (strip function, keep arg)
  sql = sql.replace(/\btoDateTime64\(([^,]+),\s*\d+\)/g, "$1");

  // toDateTime(x) → x (MySQL implicitly converts strings to datetime)
  sql = sql.replace(/\btoDateTime\(([^)]+)\)/g, "$1");

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

  // toUInt64(x) → CAST(x AS UNSIGNED)
  sql = sql.replace(/\btoUInt64\(([^)]+)\)/g, "CAST($1 AS UNSIGNED)");

  // toUUID(x) → x (MySQL doesn't have UUID type, treat as string)
  sql = sql.replace(/\btoUUID\(([^)]+)\)/g, "$1");

  // has(Array, elem) → JSON_CONTAINS(Array, CAST(elem AS JSON))
  // For the pattern has(column, {param:String}), the param is already a ?
  sql = sql.replace(
    /\bhas\(([^,]+),\s*([^)]+)\)/g,
    "JSON_CONTAINS($1, CAST($2 AS JSON))",
  );

  // arrayJoin(x) → JSON_TABLE approach (stub - specific uses need manual adjustment)
  // For tags stored as JSON arrays: arrayJoin(tags) → tags (simplified)
  // This is a rough translation; complex ARRAY JOIN patterns need manual SQL rewrite

  // tupleElement(x, n) → JSON_UNQUOTE(JSON_EXTRACT(x, CONCAT('$[', n-1, ']')))
  // Simplified: for tupleElement used in score filters, just extract field
  sql = sql.replace(
    /\btupleElement\(([^,]+),\s*(\d+)\)/g,
    "JSON_UNQUOTE(JSON_EXTRACT($1, '$[$2]'))",
  );

  // 5. Remove "LIMIT n BY col" syntax (CH-specific, not in MySQL)
  // Pattern: "LIMIT 1 BY id, project_id" → "LIMIT 1"  (approximation)
  sql = sql.replace(/\bLIMIT\s+(\d+)\s+BY\s+[^;]+/gi, "LIMIT $1");

  // 6. Remove "ANY LEFT JOIN" → "LEFT JOIN"
  sql = sql.replace(/\bANY\s+LEFT\s+JOIN\b/gi, "LEFT JOIN");
  sql = sql.replace(/\bALL\s+LEFT\s+JOIN\b/gi, "LEFT JOIN");
  sql = sql.replace(/\bANY\s+INNER\s+JOIN\b/gi, "INNER JOIN");
  sql = sql.replace(/\bALL\s+INNER\s+JOIN\b/gi, "INNER JOIN");

  // 7. Clean up multiple spaces
  sql = sql.replace(/\s{2,}/g, " ").trim();

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
