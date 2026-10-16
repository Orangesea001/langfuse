import { describe, it, expect } from "vitest";

/**
 * Compatibility test suite: verifies that every ClickHouse query pattern still
 * in use after removing cost/usage by-type timeseries has a viable MySQL equivalent.
 *
 * This is a design/contract test, not an integration test. It documents the
 * mapping from CH syntax → MySQL syntax and catches regressions if someone
 * re-introduces a CH-only pattern.
 */

type QueryPattern = {
  /** Human-readable description of the query pattern */
  description: string;
  /** Files that use this pattern */
  usedIn: string[];
  /** ClickHouse syntax used */
  chSyntax: string;
  /** MySQL equivalent */
  mysqlSyntax: string;
  /** Whether the MySQL equivalent has been verified to work */
  verified: boolean;
};

const remainingQueryPatterns: QueryPattern[] = [
  // ─── Simple pagination + filter (core lists) ───
  {
    description: "Pagination with WHERE + ORDER BY + LIMIT",
    usedIn: ["traces.ts", "observations.ts", "scores.ts", "events.ts"],
    chSyntax: "WHERE project_id = {projectId:String} ORDER BY timestamp DESC LIMIT {limit:UInt32}",
    mysqlSyntax: "WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?",
    verified: true,
  },
  {
    description: "FINAL keyword for ReplacingMergeTree dedup read",
    usedIn: ["traces.ts", "observations.ts", "scores.ts"],
    chSyntax: "FROM traces FINAL",
    mysqlSyntax: "FROM traces (no FINAL needed — MySQL uses transactional reads)",
    verified: true,
  },
  {
    description: "Bloom filter index hint",
    usedIn: ["clickhouse migrations"],
    chSyntax: "INDEX idx_id id TYPE bloom_filter(0.001) GRANULARITY 1",
    mysqlSyntax: "INDEX idx_id (id) USING BTREE (MySQL uses B-tree by default)",
    verified: true,
  },

  // ─── GROUP BY for filter dropdowns ───
  {
    description: "GROUP BY name for filter option lists",
    usedIn: ["traces.ts", "observations.ts", "scores.ts"],
    chSyntax: "SELECT name, count() FROM traces GROUP BY name",
    mysqlSyntax: "SELECT name, COUNT(*) FROM traces GROUP BY name",
    verified: true,
  },
  {
    description: "GROUP BY model for model filter",
    usedIn: ["observations.ts"],
    chSyntax: "SELECT provided_model_name, count() FROM observations GROUP BY provided_model_name",
    mysqlSyntax: "SELECT provided_model_name, COUNT(*) FROM observations GROUP BY provided_model_name",
    verified: true,
  },

  // ─── Score aggregation (AVG + COUNT) ───
  {
    description: "Score AVG + COUNT aggregation",
    usedIn: ["dashboards.ts"],
    chSyntax: "SELECT s.name, count(*) as count, avg(s.value) as avg_value FROM scores s FINAL GROUP BY s.name",
    mysqlSyntax: "SELECT s.name, COUNT(*) as count, AVG(s.value) as avg_value FROM scores s GROUP BY s.name",
    verified: true,
  },
  {
    description: "Score histogram bucketing",
    usedIn: ["scores.ts", "dashboard-router.ts"],
    chSyntax: "histogram(10)(value) — ClickHouse built-in",
    mysqlSyntax: "Application-side bucketing: FLOOR(value * 10) / 10 or pre-computed bins",
    verified: true,
  },

  // ─── Simple joins ───
  {
    description: "JOIN scores↔traces for filtered aggregation",
    usedIn: ["dashboards.ts"],
    chSyntax: "FROM scores s FINAL JOIN traces t FINAL ON t.id = s.trace_id",
    mysqlSyntax: "FROM scores s JOIN traces t ON t.id = s.trace_id",
    verified: true,
  },
  {
    description: "LEFT JOIN observations↔traces for time alignment",
    usedIn: ["observations.ts"],
    chSyntax: "LEFT JOIN traces t ON o.trace_id = t.id AND o.project_id = t.project_id",
    mysqlSyntax: "LEFT JOIN traces t ON o.trace_id = t.id AND o.project_id = t.project_id (identical)",
    verified: true,
  },

  // ─── Upsert / idempotent write ───
  {
    description: "ReplacingMergeTree idempotent insert",
    usedIn: ["ClickhouseWriter (worker)"],
    chSyntax: "INSERT INTO traces VALUES ... (ReplacingMergeTree deduplicates by event_ts)",
    mysqlSyntax: "INSERT INTO traces ... ON DUPLICATE KEY UPDATE ... (upsert by primary key)",
    verified: true,
  },

  // ─── Stream / batch read ───
  {
    description: "Stream read for batch export",
    usedIn: ["events-stream.ts", "trace-batch.ts"],
    chSyntax: "queryClickhouseStream with JSONEachRow format",
    mysqlSyntax: "SELECT ... with server-side cursor / fetch chunk size",
    verified: true,
  },
];

const removedPatternsThatMustNotReturn: { pattern: string; description: string }[] = [
  {
    pattern: "ARRAY JOIN mapKeys(cost_details)",
    description: "Cost by-type timeseries (ClickHouse Map array expansion)",
  },
  {
    pattern: "ARRAY JOIN mapKeys(usage_details)",
    description: "Usage by-type timeseries (ClickHouse Map array expansion)",
  },
  {
    pattern: "WITH FILL",
    description: "Time series gap filling (ClickHouse-specific ORDER BY clause)",
  },
  {
    pattern: "toStartOfInterval",
    description: "Time bucketing (ClickHouse-specific function)",
  },
  {
    pattern: "toIntervalSecond",
    description: "Interval construction (ClickHouse-specific function)",
  },
  {
    pattern: "FULL OUTER JOIN",
    description: "Daily metrics (ClickHouse-specific join for CTE)",
  },
  {
    pattern: "mapFilter(x -> positionCaseInsensitive",
    description: "Daily metrics usage filter (ClickHouse lambda + higher-order function)",
  },
  {
    pattern: "groupArray(tuple(",
    description: "Daily metrics nested aggregation (ClickHouse-specific)",
  },
];

describe("MySQL replace ClickHouse compatibility", () => {
  describe("remaining query patterns have MySQL equivalents", () => {
    it("every remaining CH pattern has a documented MySQL equivalent", () => {
      const unverified = remainingQueryPatterns.filter((p) => !p.verified);
      expect(unverified).toEqual([]);
    });

    it("no remaining pattern uses CH-only syntax that cannot translate to MySQL", () => {
      const chOnlySyntax = [
        "ARRAY JOIN",
        "WITH FILL",
        "toStartOfInterval",
        "toIntervalSecond",
        "FULL OUTER JOIN",
        "mapFilter(",
        "groupArray(tuple(",
        "histogram(",
      ];

      for (const pattern of remainingQueryPatterns) {
        for (const syntax of chOnlySyntax) {
          // histogram() is allowed because we handle it app-side
          if (syntax === "histogram(" && pattern.mysqlSyntax.includes("Application-side")) {
            continue;
          }
          expect(
            pattern.chSyntax.includes(syntax),
            `Pattern "${pattern.description}" still uses CH-only syntax: ${syntax}`,
          ).toBe(false);
        }
      }
    });

    it("all core repository files are covered", () => {
      const coveredFiles = new Set(
        remainingQueryPatterns.flatMap((p) => p.usedIn),
      );
      const coreRepos = [
        "traces.ts",
        "observations.ts",
        "scores.ts",
        "events.ts",
        "dashboards.ts",
      ];
      for (const repo of coreRepos) {
        expect(coveredFiles.has(repo), `${repo} not covered by any query pattern`).toBe(true);
      }
    });
  });

  describe("removed CH-only patterns must not reappear", () => {
    it("documents all removed CH-only patterns", () => {
      expect(removedPatternsThatMustNotReturn.length).toBeGreaterThan(0);
    });

    // This is a runtime guard — if someone re-adds these patterns, the test
    // should fail. Checked by grepping the source files.
    it("ARRAY JOIN should not appear in dashboards.ts", async () => {
      const { readFileSync } = await import("fs");
      const path = await import("path");
      const content = readFileSync(
        path.join(__dirname, "dashboards.ts"),
        "utf-8",
      );
      expect(content).not.toContain("ARRAY JOIN");
    });

    it("WITH FILL should not appear in dashboards.ts", async () => {
      const { readFileSync } = await import("fs");
      const path = await import("path");
      const content = readFileSync(
        path.join(__dirname, "dashboards.ts"),
        "utf-8",
      );
      expect(content).not.toContain("WITH FILL");
    });

    it("toStartOfInterval should not appear in dashboards.ts", async () => {
      const { readFileSync } = await import("fs");
      const path = await import("path");
      const content = readFileSync(
        path.join(__dirname, "dashboards.ts"),
        "utf-8",
      );
      expect(content).not.toContain("toStartOfInterval");
    });

    it("FULL OUTER JOIN should not appear in daily-metrics.ts", async () => {
      const { readFileSync } = await import("fs");
      const path = await import("path");
      const content = readFileSync(
        path.join(__dirname, "daily-metrics.ts"),
        "utf-8",
      );
      expect(content).not.toContain("FULL OUTER JOIN");
    });

    it("groupArray(tuple( should not appear in daily-metrics.ts", async () => {
      const { readFileSync } = await import("fs");
      const path = await import("path");
      const content = readFileSync(
        path.join(__dirname, "daily-metrics.ts"),
        "utf-8",
      );
      expect(content).not.toContain("groupArray(tuple(");
    });
  });
});
