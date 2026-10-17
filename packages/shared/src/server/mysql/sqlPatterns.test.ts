/**
 * Unit tests verifying that MySQL SQL patterns are correct
 * (replacing ClickHouse patterns).
 */
import { describe, it, expect } from "vitest";
import { translateQuery } from "./sqlTranslator";

describe("MySQL SQL pattern replacements", () => {
  describe("CASE WHEN (replaces multiIf)", () => {
    it("single condition", () => {
      const sql = `SELECT CASE WHEN x = 1 THEN 'a' ELSE 'b' END`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("CASE WHEN x = 1 THEN 'a' ELSE 'b' END");
    });

    it("multiple conditions", () => {
      const sql = `SELECT CASE WHEN x = 1 THEN 'a' WHEN x = 2 THEN 'b' ELSE 'c' END`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain(
        "CASE WHEN x = 1 THEN 'a' WHEN x = 2 THEN 'b' ELSE 'c' END",
      );
    });
  });

  describe("JSON_ARRAYAGG (replaces groupArrayIf)", () => {
    it("numeric scores aggregation", () => {
      const sql = `JSON_ARRAYAGG(CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN JSON_OBJECT('name', name, 'value', avg_value) ELSE NULL END)`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("JSON_ARRAYAGG");
      expect(result).toContain("JSON_OBJECT");
      expect(result).toContain("CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN')");
    });

    it("categorical scores aggregation", () => {
      const sql = `JSON_ARRAYAGG(CASE WHEN data_type = 'CATEGORICAL' AND LENGTH(string_value) > 0 THEN CONCAT(name, ':', string_value) ELSE NULL END)`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("JSON_ARRAYAGG");
      expect(result).toContain("CONCAT(name, ':', string_value)");
    });
  });

  describe("TIMESTAMPDIFF (replaces dateDiff)", () => {
    it("millisecond precision", () => {
      const sql = `TIMESTAMPDIFF(MICROSECOND, start_time, end_time) / 1000`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain(
        "TIMESTAMPDIFF(MICROSECOND, start_time, end_time) / 1000",
      );
    });
  });

  describe("IFNULL (replaces ifNull)", () => {
    it("basic usage", () => {
      const sql = `SELECT IFNULL(x, 0) as val`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("IFNULL(x, 0)");
    });
  });

  describe("NULLIF (replaces nullIf)", () => {
    it("basic usage", () => {
      const sql = `SELECT NULLIF(x, '') as val`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("NULLIF(x, '')");
    });
  });

  describe("CHAR_LENGTH (replaces lengthUTF8)", () => {
    it("basic usage", () => {
      const sql = `SELECT CHAR_LENGTH(name) as len`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("CHAR_LENGTH(name)");
    });
  });

  describe("JSON functions (replace CH array/map)", () => {
    it("JSON_CONTAINS", () => {
      const sql = `SELECT * FROM t WHERE JSON_CONTAINS(tags, '"value"')`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("JSON_CONTAINS(tags, '\"value\"')");
    });

    it("JSON_EXTRACT", () => {
      const sql = `SELECT JSON_EXTRACT(metadata, '$.key') as val`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("JSON_EXTRACT(metadata, '$.key')");
    });

    it("JSON_OBJECT in aggregation", () => {
      const sql = `JSON_OBJECT('name', s.name, 'value', s.exp_avg)`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain(
        "JSON_OBJECT('name', s.name, 'value', s.exp_avg)",
      );
    });

    it("json_map_sum_like UDF", () => {
      const sql = `json_map_sum_like(usage_details, '%input%') as input_usage`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("json_map_sum_like(usage_details, '%input%')");
    });
  });

  describe("ON DUPLICATE KEY UPDATE (replaces ReplacingMergeTree)", () => {
    it("upsert pattern", () => {
      const sql = `INSERT INTO traces (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("ON DUPLICATE KEY UPDATE name = VALUES(name)");
    });
  });

  describe("CRC32 (replaces xxHash32)", () => {
    it("hash in ORDER BY", () => {
      const sql = `ORDER BY CRC32(trace_id) DESC`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("CRC32(trace_id) DESC");
    });
  });

  describe("FROM_UNIXTIME (replaces fromUnixTimestamp64Milli)", () => {
    it("time conversion", () => {
      const sql = `FROM_UNIXTIME(ms / 1000)`;
      const { sql: result } = translateQuery(sql);
      expect(result).toContain("FROM_UNIXTIME(ms / 1000)");
    });
  });
});

describe("translateQuery with real SQL patterns", () => {
  it("complex trace query with multiple params", () => {
    const { sql, params } = translateQuery(
      `SELECT id, name FROM traces WHERE project_id = {projectId: String} AND timestamp >= {startTs: DateTime64(3)} AND timestamp <= {endTs: DateTime64(3)} LIMIT {limit: UInt32}`,
      {
        projectId: "proj-1",
        startTs: "2024-01-01",
        endTs: "2024-12-31",
        limit: 100,
      },
    );
    expect(sql).toBe(
      "SELECT id, name FROM traces WHERE project_id = ? AND timestamp >= ? AND timestamp <= ? LIMIT ?",
    );
    expect(params).toEqual(["proj-1", "2024-01-01", "2024-12-31", 100]);
  });

  it("IN clause with Array param", () => {
    const { sql, params } = translateQuery(
      `SELECT * FROM traces WHERE id IN ({traceIds: Array(String)})`,
      { traceIds: ["t1", "t2", "t3"] },
    );
    expect(sql).toBe("SELECT * FROM traces WHERE id IN (?)");
    expect(params).toEqual([["t1", "t2", "t3"]]);
  });

  it("score aggregation query", () => {
    const { sql, params } = translateQuery(
      `SELECT trace_id, JSON_ARRAYAGG(CASE WHEN data_type IN ('NUMERIC', 'BOOLEAN') THEN JSON_OBJECT('name', name, 'value', avg_value) ELSE NULL END) AS scores_avg FROM scores WHERE project_id = {projectId: String} GROUP BY trace_id`,
      { projectId: "p1" },
    );
    expect(sql).toContain("project_id = ?");
    expect(sql).toContain("JSON_ARRAYAGG");
    expect(sql).toContain("JSON_OBJECT");
    expect(params).toEqual(["p1"]);
  });
});
