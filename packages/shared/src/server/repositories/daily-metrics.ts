// Disabled: daily metrics repository removed for internal deployment.
// The generateDailyMetrics and getDailyMetricsCount functions used heavy
// ClickHouse-specific syntax (FULL OUTER JOIN, ReplacingMergeTree FINAL,
// mapFilter, arraySum(mapValues), groupArray(tuple)) which is not needed
// when replacing ClickHouse with MySQL.

export const generateDailyMetrics = async () => {
  throw new Error("Daily metrics have been disabled for internal deployment.");
};

export const getDailyMetricsCount = async () => {
  throw new Error("Daily metrics have been disabled for internal deployment.");
};
