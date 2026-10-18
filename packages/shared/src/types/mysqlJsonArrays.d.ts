/**
 * Type augmentation for MySQL migration: String[] fields are now Json in MySQL.
 * This provides type helpers for accessing these fields safely.
 */
declare module "@prisma/client" {
  // Type helper: cast Json field to string array
  // Usage: asStringArray(prompt.labels)
}

/** Cast a Prisma JsonValue (from former String[] field) to string[] */
export function asStringArray<T>(value: T): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}
