import { describe, it, expect } from "vitest";
import {
  translateQuery,
  parseClickhouseUTCDateTimeFormat,
  convertDateToMySqlDateTime,
} from "./sqlTranslator";

describe("sqlTranslator", () => {
  describe("translateQuery", () => {
    // ─── FINAL keyword ───
    it("should remove FINAL keyword", () => {
      const result = translateQuery(
        "SELECT * FROM traces FINAL WHERE id = 1",
        {},
      );
      expect(result.sql).toBe("SELECT * FROM traces WHERE id = 1");
    });

    it("should remove FINAL after table alias", () => {
      const result = translateQuery(
        "SELECT * FROM scores s FINAL WHERE s.project_id = ?",
        {},
      );
      expect(result.sql).not.toContain("FINAL");
      expect(result.sql).toContain("FROM scores s");
    });

    // ─── Named parameters ───
    it("should replace named parameters with positional ?", () => {
      const result = translateQuery(
        "SELECT * FROM traces WHERE project_id = {projectId:String} AND name = {name:String}",
        { projectId: "proj-1", name: "my-trace" },
      );
      expect(result.sql).toBe(
        "SELECT * FROM traces WHERE project_id = ? AND name = ?",
      );
      expect(result.params).toEqual(["proj-1", "my-trace"]);
    });

    it("should handle DateTime64 parameter type", () => {
      const result = translateQuery(
        "WHERE timestamp >= {fromTime:DateTime64(3)}",
        { fromTime: 1704067200000 },
      );
      expect(result.sql).toBe("WHERE timestamp >= ?");
      expect(result.params).toEqual([1704067200000]);
    });

    it("should handle UInt64 parameter type", () => {
      const result = translateQuery("WHERE count > {minCount:UInt64}", {
        minCount: 100,
      });
      expect(result.sql).toBe("WHERE count > ?");
      expect(result.params).toEqual([100]);
    });

    it("should handle multiple params of different types", () => {
      const result = translateQuery(
        "WHERE project_id = {projectId:String} AND timestamp >= {from:DateTime64(3)} AND timestamp < {to:DateTime64(3)} LIMIT {limit:UInt32}",
        { projectId: "p1", from: "2024-01-01", to: "2024-12-31", limit: 100 },
      );
      expect(result.sql).toBe(
        "WHERE project_id = ? AND timestamp >= ? AND timestamp < ? LIMIT ?",
      );
      expect(result.params).toEqual(["p1", "2024-01-01", "2024-12-31", 100]);
    });

    // ─── Function translations ───
    it("should translate toDateTime function", () => {
      const result = translateQuery("toDateTime({ts:DateTime64(3)})", {
        ts: "2024-01-01",
      });
      expect(result.sql).toBe("?");
    });

    it("should translate toDateTime64 function", () => {
      const result = translateQuery("toDateTime64(timestamp, 3)", {});
      expect(result.sql).toBe("timestamp");
    });

    it("should translate toDate function", () => {
      const result = translateQuery("toDate(timestamp)", {});
      expect(result.sql).toBe("DATE(timestamp)");
    });

    it("should translate toYYYYMM function", () => {
      const result = translateQuery("toYYYYMM(timestamp)", {});
      expect(result.sql).toBe("DATE_FORMAT(timestamp, '%Y%m')");
    });

    it("should translate toString function", () => {
      const result = translateQuery("toString(value)", {});
      expect(result.sql).toBe("CAST(value AS CHAR)");
    });

    it("should translate toInt64 function", () => {
      const result = translateQuery("toInt64(value)", {});
      expect(result.sql).toBe("CAST(value AS SIGNED)");
    });

    it("should translate toInt32 function", () => {
      const result = translateQuery("toInt32(value)", {});
      expect(result.sql).toBe("CAST(value AS SIGNED)");
    });

    it("should translate toUInt64 function", () => {
      const result = translateQuery("toUInt64(count)", {});
      expect(result.sql).toBe("CAST(count AS UNSIGNED)");
    });

    it("should translate toFloat64 function", () => {
      const result = translateQuery("toFloat64(ratio)", {});
      expect(result.sql).toBe("CAST(ratio AS DOUBLE)");
    });

    it("should translate has() function", () => {
      const result = translateQuery(
        "has(e.metadata_names, {metadataKey:String})",
        { metadataKey: "key1" },
      );
      expect(result.sql).toBe(
        "JSON_CONTAINS(e.metadata_names, CAST(? AS JSON))",
      );
      expect(result.params).toEqual(["key1"]);
    });

    it("should translate tupleElement function", () => {
      const result = translateQuery("tupleElement(option, 2)", {});
      expect(result.sql).toBe("JSON_UNQUOTE(JSON_EXTRACT(option, '$[2]'))");
    });

    // ─── LIMIT BY syntax ───
    it("should translate LIMIT n BY col to LIMIT n", () => {
      const result = translateQuery(
        "SELECT * FROM events ORDER BY event_ts DESC LIMIT 1 BY id, project_id",
        {},
      );
      expect(result.sql).toBe(
        "SELECT * FROM events ORDER BY event_ts DESC LIMIT 1",
      );
    });

    // ─── JOIN variants ───
    it("should translate ANY LEFT JOIN to LEFT JOIN", () => {
      const result = translateQuery(
        "SELECT * FROM t ANY LEFT JOIN s ON t.id = s.id",
        {},
      );
      expect(result.sql).toBe("SELECT * FROM t LEFT JOIN s ON t.id = s.id");
    });

    it("should translate ALL LEFT JOIN to LEFT JOIN", () => {
      const result = translateQuery(
        "SELECT * FROM t ALL LEFT JOIN s ON t.id = s.id",
        {},
      );
      expect(result.sql).toBe("SELECT * FROM t LEFT JOIN s ON t.id = s.id");
    });

    // ─── Complex real-world queries ───
    it("should handle complex query with multiple CH features", () => {
      const result = translateQuery(
        `SELECT name, count(*) as cnt FROM scores s FINAL WHERE s.project_id = {projectId:String} GROUP BY s.name ORDER BY cnt DESC`,
        { projectId: "proj-1" },
      );
      expect(result.sql).toContain("GROUP BY s.name");
      expect(result.sql).not.toContain("FINAL");
      expect(result.sql).toContain("?");
      expect(result.params).toEqual(["proj-1"]);
    });

    it("should handle trace query with FINAL and named params", () => {
      const result = translateQuery(
        `SELECT id, name, timestamp FROM traces t FINAL WHERE t.project_id = {projectId:String} AND t.timestamp >= {fromTime:DateTime64(3)} ORDER BY t.timestamp DESC LIMIT 100`,
        { projectId: "proj-1", fromTime: "2024-01-01 00:00:00" },
      );
      expect(result.sql).not.toContain("FINAL");
      expect(result.sql).not.toContain("{projectId:String}");
      expect(result.sql).not.toContain("{fromTime:DateTime64(3)}");
      expect(result.params).toEqual(["proj-1", "2024-01-01 00:00:00"]);
    });

    it("should handle observation query with toDateTime64 in WHERE", () => {
      const result = translateQuery(
        `SELECT * FROM observations o FINAL WHERE o.project_id = {projectId:String} AND o.start_time >= toDateTime64({from:DateTime64(3)}, 3) ORDER BY o.start_time DESC`,
        { projectId: "proj-1", from: "2024-01-01" },
      );
      expect(result.sql).not.toContain("FINAL");
      expect(result.sql).not.toContain("toDateTime64");
      expect(result.sql).toContain("?");
    });

    it("should handle scores with toInt64 and toString", () => {
      const result = translateQuery(
        `SELECT name, toInt64(value) as int_val, toString(source) as src FROM scores FINAL WHERE project_id = {projectId:String}`,
        { projectId: "proj-1" },
      );
      expect(result.sql).toContain("CAST(value AS SIGNED)");
      expect(result.sql).toContain("CAST(source AS CHAR)");
      expect(result.sql).not.toContain("FINAL");
    });

    // ─── Edge cases ───
    it("should return empty params when no params provided", () => {
      const result = translateQuery("SELECT 1");
      expect(result.params).toEqual([]);
    });

    it("should handle query with only FINAL and no params", () => {
      const result = translateQuery("SELECT count(*) FROM traces FINAL", {});
      expect(result.sql).toBe("SELECT count(*) FROM traces");
      expect(result.params).toEqual([]);
    });

    it("should clean up multiple spaces after transformations", () => {
      const result = translateQuery(
        "SELECT *  FROM  traces  FINAL  WHERE  id = 1",
        {},
      );
      expect(result.sql).not.toContain("  ");
    });
  });

  describe("parseClickhouseUTCDateTimeFormat", () => {
    it("should parse CH datetime string to Date", () => {
      const result = parseClickhouseUTCDateTimeFormat(
        "2024-01-15 10:30:00.000",
      );
      expect(result.toISOString()).toBe("2024-01-15T10:30:00.000Z");
    });

    it("should parse CH datetime without milliseconds", () => {
      const result = parseClickhouseUTCDateTimeFormat("2024-01-15 10:30:00");
      expect(result.toISOString()).toBe("2024-01-15T10:30:00.000Z");
    });

    it("should parse MySQL datetime string", () => {
      const result = parseClickhouseUTCDateTimeFormat("2024-01-15 10:30:00");
      expect(result.getFullYear()).toBe(2024);
      expect(result.getMonth()).toBe(0); // January
      expect(result.getDate()).toBe(15);
    });
  });

  describe("convertDateToMySqlDateTime", () => {
    it("should convert Date to MySQL datetime string", () => {
      const result = convertDateToMySqlDateTime(
        new Date("2024-01-15T10:30:00.000Z"),
      );
      expect(result).toBe("2024-01-15 10:30:00");
    });

    it("should handle midnight", () => {
      const result = convertDateToMySqlDateTime(
        new Date("2024-01-01T00:00:00.000Z"),
      );
      expect(result).toBe("2024-01-01 00:00:00");
    });

    it("should handle end of day", () => {
      const result = convertDateToMySqlDateTime(
        new Date("2024-12-31T23:59:59.999Z"),
      );
      expect(result).toBe("2024-12-31 23:59:59");
    });
  });
});
