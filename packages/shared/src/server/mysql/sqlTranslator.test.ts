import { describe, it, expect } from "vitest";
import {
  translateQuery,
  parseClickhouseUTCDateTimeFormat,
  convertDateToMySqlDateTime,
} from "./sqlTranslator";

describe("sqlTranslator", () => {
  describe("translateQuery", () => {
    it("should remove FINAL keyword", () => {
      const result = translateQuery(
        "SELECT * FROM traces FINAL WHERE id = 1",
        {},
      );
      expect(result.sql).toBe("SELECT * FROM traces  WHERE id = 1");
    });

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

    it("should translate toDateTime function", () => {
      const result = translateQuery("toDateTime({ts:DateTime64(3)})", {
        ts: "2024-01-01",
      });
      expect(result.sql).toBe("?");
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

    it("should return empty params when no params provided", () => {
      const result = translateQuery("SELECT 1");
      expect(result.params).toEqual([]);
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
  });

  describe("convertDateToMySqlDateTime", () => {
    it("should convert Date to MySQL datetime string", () => {
      const result = convertDateToMySqlDateTime(
        new Date("2024-01-15T10:30:00.000Z"),
      );
      expect(result).toBe("2024-01-15 10:30:00");
    });
  });
});
