import { queryAnalytics } from "./clickhouse";
import { createFilterFromFilterState } from "../queries/analytics-sql/factory";
import { FilterState } from "../../types";
import { DateTimeFilter, FilterList } from "../queries";
import { dashboardColumnDefinitions } from "../tableMappings";
import { convertDateToAnalyticsDateTime } from "../analytics-client/client";
import { SCORE_TO_TRACE_OBSERVATIONS_INTERVAL } from "./constants";

export type DateTrunc = "month" | "week" | "day" | "hour" | "minute";

const extractEnvironmentFilterFromFilters = (
  filter: FilterState,
): { envFilter: FilterState; remainingFilters: FilterState } => {
  return {
    envFilter: filter.filter((f) => f.column === "environment"),
    remainingFilters: filter.filter((f) => f.column !== "environment"),
  };
};

const convertEnvFilterToClickhouseFilter = (filter: FilterState) => {
  return createFilterFromFilterState(filter, [
    {
      analyticsSelect: "environment",
      analyticsTableName: "traces",
      uiTableId: "environment",
      uiTableName: "Environment",
    },
  ]);
};

export const getScoreAggregate = async (
  projectId: string,
  filter: FilterState,
) => {
  const { envFilter, remainingFilters } =
    extractEnvironmentFilterFromFilters(filter);
  const environmentFilter = new FilterList(
    convertEnvFilterToClickhouseFilter(envFilter),
  ).apply();
  const chFilter = new FilterList(
    createFilterFromFilterState(remainingFilters, dashboardColumnDefinitions),
  );

  const timeFilter = chFilter.find(
    (f) =>
      f.field === "timestamp" && (f.operator === ">=" || f.operator === ">"),
  ) as DateTimeFilter | undefined;

  const chFilterApplied = chFilter.apply();

  const hasTraceFilter = chFilter.find((f) => f.analyticsTable === "traces");
  // TODO: Validate whether we can filter traces on timestamp here.

  const query = `
    SELECT 
      s.name,
      count(*) as count,
      avg(s.value) as avg_value,
      s.source,
      s.data_type
    FROM scores s  
     ${hasTraceFilter ? "JOIN traces t  ON t.id = s.trace_id AND t.project_id = s.project_id" : ""}
    WHERE s.project_id = {projectId: String}
    AND ${chFilterApplied.query}
    ${environmentFilter.query ? `AND ${environmentFilter.query}` : ""}
    ${timeFilter && hasTraceFilter ? `AND t.timestamp >= {tracesTimestamp: DateTime64(3)} - ${SCORE_TO_TRACE_OBSERVATIONS_INTERVAL}` : ""}
    GROUP BY s.name, s.source, s.data_type
    ORDER BY count(*) DESC
    `;

  const result = await queryAnalytics<{
    name: string;
    count: string;
    avg_value: string;
    source: string;
    data_type: string;
  }>({
    query,
    params: {
      projectId,
      ...chFilterApplied.params,
      ...environmentFilter.params,
      ...(timeFilter
        ? { tracesTimestamp: convertDateToAnalyticsDateTime(timeFilter.value) }
        : {}),
    },
    tags: { projectId },
  });

  return result;
};

export const extractFromAndToTimestampsFromFilter = (filter?: FilterState) => {
  if (!filter)
    throw new Error("Time Filter is required for time series queries");

  const fromTimestamp = filter.filter(
    (f) => f.type === "datetime" && (f.operator === ">" || f.operator === ">="),
  );

  const toTimestamp = filter.filter(
    (f) => f.type === "datetime" && (f.operator === "<" || f.operator === "<="),
  );

  return [fromTimestamp[0], toTimestamp[0]];
};
