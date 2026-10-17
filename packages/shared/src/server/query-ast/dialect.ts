/* eslint-disable @repo/no-exotic-operators */
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  type Dialect,
} from "kysely";

import { AnalyticsQueryCompiler } from "./compiler";
import type { AnalyticsDatabase } from "./schema";

/**
 * Compile-only ClickHouse dialect. Queries are never executed through Kysely;
 * the existing `queryAnalytics` seam remains the exec path. DummyDriver
 * throws if anyone tries to `.execute()`.
 */
export class AnalyticsCompileDialect implements Dialect {
  createDriver() {
    return new DummyDriver();
  }

  createQueryCompiler() {
    return new AnalyticsQueryCompiler();
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<any>) {
    return new SqliteIntrospector(db);
  }
}

let compileDb: Kysely<AnalyticsDatabase> | undefined;

export function getClickhouseKysely(): Kysely<AnalyticsDatabase> {
  compileDb ??= new Kysely<AnalyticsDatabase>({
    dialect: new AnalyticsCompileDialect(),
  });
  return compileDb;
}
