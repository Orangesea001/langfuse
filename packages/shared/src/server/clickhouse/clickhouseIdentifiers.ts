/**
 * Quoting helpers for SQL identifiers and string literals.
 * Updated to use MySQL-compatible quoting (backticks for identifiers).
 *
 * Preserved for backward compatibility with worker imports.
 */

/**
 * Assert that a value is a valid SQL identifier.
 */
export function assertClickhouseIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

/**
 * Quote an identifier using MySQL backtick quoting.
 */
export function quoteClickhouseIdentifier(
  value: string,
  label: string,
): string {
  assertClickhouseIdentifier(value, label);
  const escaped = value.replace(/`/g, "``");
  return `\`${escaped}\``;
}

/**
 * Quote a string literal using MySQL single-quote escaping.
 */
export function quoteClickhouseString(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Invalid string: NUL bytes are not supported");
  }
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}'`;
}

/**
 * Qualify a table name with its database using MySQL backtick quoting.
 */
export function qualifiedClickhouseTableName(
  database: string,
  table: string,
): string {
  return `${quoteClickhouseIdentifier(database, "database")}.${quoteClickhouseIdentifier(table, "table")}`;
}
