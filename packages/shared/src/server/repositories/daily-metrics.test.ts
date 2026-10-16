import { describe, it, expect } from "vitest";
import { generateDailyMetrics, getDailyMetricsCount } from "./daily-metrics";

describe("daily-metrics (disabled for internal deployment)", () => {
  it("generateDailyMetrics should throw disabled error", async () => {
    await expect(generateDailyMetrics()).rejects.toThrow(
      "Daily metrics have been disabled for internal deployment",
    );
  });

  it("getDailyMetricsCount should throw disabled error", async () => {
    await expect(getDailyMetricsCount()).rejects.toThrow(
      "Daily metrics have been disabled for internal deployment",
    );
  });
});
