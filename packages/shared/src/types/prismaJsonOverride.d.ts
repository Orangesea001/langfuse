/**
 * Global type override for Prisma client models.
 * 
 * When migrating from PostgreSQL to MySQL, String[] fields became Json fields.
 * Prisma generates `JsonValue` types for Json fields, but our application code
 * expects `string[]` for these specific fields.
 * 
 * This file provides type-level helpers. For runtime, use:
 *   import { asStringArray } from "../server/mysql/jsonArrayHelper";
 */

// Re-export from Prisma
export type { JsonValue } from "@prisma/client/runtime/library";
