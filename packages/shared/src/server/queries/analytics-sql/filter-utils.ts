import { convertDateToAnalyticsDateTime } from "../../analytics-client/client";
import { DateTimeFilter, type FilterList } from "./analytics-filter";

/**
 * Internal helper: extract and convert time filter from FilterList
 * Common pattern: find time filter and convert to ClickHouse DateTime format
 */
export function extractTimeFilter(
  filter: FilterList,
  tableName: "events_proto" | "traces" = "events_proto",
  fieldName: "start_time" | "timestamp" = "start_time",
  prefix?: "e" | "t",
): string | null {
  const timeFilter = filter.find((filterItem) => {
    // For events tables, match any events_* prefix (events_proto, events_core, events_full)
    const normalizedField = filterItem.field.replaceAll('"', "");
    const expectedField = prefix ? `${prefix}.${fieldName}` : fieldName;

    return (
      (tableName === "events_proto"
        ? filterItem.analyticsTable.startsWith("events_")
        : filterItem.analyticsTable === tableName) &&
      (normalizedField === expectedField ||
        (!prefix && normalizedField.endsWith(`.${fieldName}`))) &&
      (filterItem.operator === ">=" || filterItem.operator === ">")
    );
  });

  return timeFilter
    ? convertDateToAnalyticsDateTime((timeFilter as DateTimeFilter).value)
    : null;
}
