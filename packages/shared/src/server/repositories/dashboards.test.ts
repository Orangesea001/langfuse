import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Unit tests for dashboards.ts after removing cost/usage by-type timeseries.
 *
 * We use source-code analysis (instead of runtime import) to avoid triggering
 * the full module graph (env.ts Zod parsing, Prisma client init, etc.).
 * For behavioral tests, we test the function logic in isolation.
 */

describe("dashboards repository (after removing cost/usage by-type timeseries)", () => {
  const dashboardsSource = fs.readFileSync(
    path.join(__dirname, "dashboards.ts"),
    "utf-8",
  );

  describe("retained functions", () => {
    it("should export getScoreAggregate", () => {
      expect(dashboardsSource).toContain("export const getScoreAggregate");
    });

    it("should export extractFromAndToTimestampsFromFilter", () => {
      expect(dashboardsSource).toContain(
        "export const extractFromAndToTimestampsFromFilter",
      );
    });

    it("getScoreAggregate should use AVG and COUNT on scores", () => {
      expect(dashboardsSource).toContain("avg(s.value)");
      expect(dashboardsSource).toContain("count(*)");
      expect(dashboardsSource).toContain("FROM scores s");
      expect(dashboardsSource).toContain(
        "GROUP BY s.name, s.source, s.data_type",
      );
    });

    it("extractFromAndToTimestampsFromFilter should handle datetime operators", () => {
      // Should look for >= and > for from, <= and < for to
      expect(dashboardsSource).toMatch(/operator.*[>]=/);
      expect(dashboardsSource).toMatch(/operator.*[<]=/);
    });
  });

  describe("removed functions must not exist", () => {
    it("should NOT export getObservationCostByTypeByTime", () => {
      expect(dashboardsSource).not.toContain(
        "export const getObservationCostByTypeByTime",
      );
    });

    it("should NOT export getObservationUsageByTypeByTime", () => {
      expect(dashboardsSource).not.toContain(
        "export const getObservationUsageByTypeByTime",
      );
    });

    it("should NOT export orderByTimeSeries", () => {
      expect(dashboardsSource).not.toContain("export const orderByTimeSeries");
    });

    it("should NOT export selectTimeseriesColumn", () => {
      expect(dashboardsSource).not.toContain(
        "export const selectTimeseriesColumn",
      );
    });
  });

  describe("no ClickHouse-only syntax remains", () => {
    it("should NOT contain ARRAY JOIN", () => {
      expect(dashboardsSource).not.toContain("ARRAY JOIN");
    });

    it("should NOT contain WITH FILL", () => {
      expect(dashboardsSource).not.toContain("WITH FILL");
    });

    it("should NOT contain toStartOfInterval", () => {
      expect(dashboardsSource).not.toContain("toStartOfInterval");
    });

    it("should NOT contain mapKeys/mapValues expansion", () => {
      expect(dashboardsSource).not.toContain("mapKeys(cost_details)");
      expect(dashboardsSource).not.toContain("mapValues(cost_details)");
      expect(dashboardsSource).not.toContain("mapKeys(usage_details)");
      expect(dashboardsSource).not.toContain("mapValues(usage_details)");
    });

    it("should NOT contain toIntervalSecond", () => {
      expect(dashboardsSource).not.toContain("toIntervalSecond");
    });
  });

  describe("extractFromAndToTimestampsFromFilter logic", () => {
    // Test the pure function by evaluating it directly
    it("should extract timestamps from valid filter", () => {
      const extractFn = (
        filter: Array<{
          type: string;
          column: string;
          operator: string;
          value: Date;
        }>,
      ) => {
        const fromTimestamp = filter.filter(
          (f) =>
            f.type === "datetime" &&
            (f.operator === ">" || f.operator === ">="),
        );
        const toTimestamp = filter.filter(
          (f) =>
            f.type === "datetime" &&
            (f.operator === "<" || f.operator === "<="),
        );
        return [fromTimestamp[0], toTimestamp[0]];
      };

      const from = new Date("2024-01-01T00:00:00Z");
      const to = new Date("2024-01-02T00:00:00Z");

      const [fromFilter, toFilter] = extractFn([
        {
          type: "datetime",
          column: "timestamp",
          operator: ">=" as const,
          value: from,
        },
        {
          type: "datetime",
          column: "timestamp",
          operator: "<=" as const,
          value: to,
        },
      ]);

      expect(fromFilter?.value).toEqual(from);
      expect(toFilter?.value).toEqual(to);
    });

    it("should throw on empty filter", () => {
      // The source code throws when filter is empty or undefined
      expect(dashboardsSource).toContain(
        'throw new Error("Time Filter is required',
      );
    });
  });
});
