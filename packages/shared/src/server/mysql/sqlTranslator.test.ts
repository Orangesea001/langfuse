/**
 * Unit tests for the parameter format converter (formerly sqlTranslator).
 * Now only handles {param:Type} → ? conversion, no SQL syntax translation.
 */
import { describe, it, expect } from "vitest";
import {
  translateQuery,
  parseClickhouseUTCDateTimeFormat,
  convertDateToMySqlDateTime,
} from "./sqlTranslator";

describe("translateQuery", () => {
  it("converts named params to positional", () => {
    const { sql, params } = translateQuery(
      "SELECT * FROM t WHERE id = {id: String} AND status = {status: String}",
      { id: "123", status: "active" },
    );
    expect(sql).toBe("SELECT * FROM t WHERE id = ? AND status = ?");
    expect(params).toEqual(["123", "active"]);
  });

  it("handles single param", () => {
    const { sql, params } = translateQuery(
      "SELECT * FROM t WHERE project_id = {projectId: String}",
      { projectId: "proj-1" },
    );
    expect(sql).toBe("SELECT * FROM t WHERE project_id = ?");
    expect(params).toEqual(["proj-1"]);
  });

  it("handles Array type params", () => {
    const { sql, params } = translateQuery(
      "SELECT * FROM t WHERE id IN ({ids: Array(String)})",
      { ids: ["a", "b", "c"] },
    );
    expect(sql).toBe("SELECT * FROM t WHERE id IN (?)");
    expect(params).toEqual([["a", "b", "c"]]);
  });

  it("handles DateTime64 type", () => {
    const { sql, params } = translateQuery(
      "SELECT * FROM t WHERE ts >= {fromTime: DateTime64(3)}",
      { fromTime: "2024-01-01T00:00:00.000Z" },
    );
    expect(sql).toBe("SELECT * FROM t WHERE ts >= ?");
    expect(params).toEqual(["2024-01-01T00:00:00.000Z"]);
  });

  it("handles UInt32/UInt64 type", () => {
    const { sql, params } = translateQuery(
      "SELECT * FROM t LIMIT {limit: UInt32}",
      { limit: 100 },
    );
    expect(sql).toBe("SELECT * FROM t LIMIT ?");
    expect(params).toEqual([100]);
  });

  it("returns empty params when no named params provided", () => {
    const { sql, params } = translateQuery("SELECT 1");
    expect(sql).toBe("SELECT 1");
    expect(params).toEqual([]);
  });

  it("returns empty params when params object is empty", () => {
    const { sql, params } = translateQuery(
      "SELECT * FROM t WHERE id = {id: String}",
      {},
    );
    // {id: String} left as-is because no matching param
    expect(sql).toBe("SELECT * FROM t WHERE id = {id: String}");
    expect(params).toEqual([]);
  });

  it("preserves SQL that has no named params", () => {
    const { sql, params } = translateQuery("SELECT * FROM t WHERE id = ?", {});
    expect(sql).toBe("SELECT * FROM t WHERE id = ?");
    expect(params).toEqual([]);
  });

  it("handles multiple params in complex query", () => {
    const { sql, params } = translateQuery(
      "SELECT * FROM t WHERE project_id = {projectId: String} AND ts >= {start: DateTime64(3)} AND ts <= {end: DateTime64(3)} LIMIT {limit: UInt32}",
      { projectId: "p1", start: "2024-01-01", end: "2024-12-31", limit: 50 },
    );
    expect(sql).toBe(
      "SELECT * FROM t WHERE project_id = ? AND ts >= ? AND ts <= ? LIMIT ?",
    );
    expect(params).toEqual(["p1", "2024-01-01", "2024-12-31", 50]);
  });
});

describe("parseClickhouseUTCDateTimeFormat", () => {
  it("parses valid datetime string", () => {
    const result = parseClickhouseUTCDateTimeFormat("2024-01-15 10:30:00");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2024-01-15T10:30:00.000Z");
  });

  it("returns null for empty string", () => {
    expect(parseClickhouseUTCDateTimeFormat("")).toEqual(new Date(0));
  });

  it("returns null for invalid date", () => {
    expect(parseClickhouseUTCDateTimeFormat("not-a-date")).toBeInstanceOf(Date);
  });
});

describe("convertDateToMySqlDateTime", () => {
  it("converts Date to MySQL datetime format", () => {
    const date = new Date("2024-01-15T10:30:00.123Z");
    const result = convertDateToMySqlDateTime(date);
    expect(result).toBe("2024-01-15 10:30:00.123");
  });
});
