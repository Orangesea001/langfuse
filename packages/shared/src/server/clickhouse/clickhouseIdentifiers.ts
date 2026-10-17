/**
 * Quoting helpers for SQL identifiers and string literals.
 * Updated to use MySQL-compatible quoting (backticks for identifiers).
 */

export function assertClickhouseIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function quoteClickhouseIdentifier(
  value: string,
  label: string,
): string {
  assertClickhouseIdentifier(value, label);
  const escaped = value.replace(/`/g, "``");
  return `\`${escaped}\``;
}

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
 * Qualifies a table with its database.
 * Uses MySQL backtick quoting.
 */
export function qualifiedClickhouseTableName(
  database: string,
  table: string,
): string {
  return `${quoteClickhouseIdentifier(database, "database")}.${quoteClickhouseIdentifier(table, "table")}`;
}
