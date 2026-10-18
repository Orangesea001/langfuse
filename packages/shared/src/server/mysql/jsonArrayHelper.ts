/**
 * Helper for Json fields that were previously String[] in PostgreSQL.
 * MySQL doesn't support native array types in Prisma, so these fields
 * are now stored as JSON. This module provides type-safe accessors.
 */
import { type JsonValue } from "@prisma/client/runtime/library";

/** Cast a Json field to string[], with fallback to empty array */
export function asStringArray(value: JsonValue | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Cast a Json field to number[], with fallback to empty array */
export function asNumberArray(value: JsonValue | null | undefined): number[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value as number[];
  return [];
}

/** Check if a Json array field includes a value */
export function jsonIncludes(
  arr: JsonValue | null | undefined,
  value: string,
): boolean {
  return asStringArray(arr).includes(value);
}
