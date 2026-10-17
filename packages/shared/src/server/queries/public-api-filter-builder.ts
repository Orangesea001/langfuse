import { eventsTableIsRootObservationSql } from "../../eventsTable";
import { filterOperators } from "../../interfaces/filters";
import {
  FilterList,
  DateTimeFilter,
  ArrayOptionsFilter,
  StringOptionsFilter,
  CategoryOptionsFilter,
  StringFilter,
  NumberFilter,
  BooleanFilter,
  type ClickhouseOperator,
} from "./analytics-sql/analytics-filter";
import { z } from "zod";
import type { EventsTableFilterState } from "../../types";
import type {
  UiColumnMappings,
  ColumnDefinition,
} from "../../tableDefinitions";
import { createFilterFromFilterState } from "./analytics-sql/factory";

export type ApiColumnMapping = {
  id: string;
  analyticsSelect: string;
  analyticsTable: string;
  filterType: string;
  operator?: ClickhouseOperator;
  analyticsPrefix?: string;
};

/**
 * Base column definition for traces table mappings
 * Single source of truth for all trace column mappings
 */
const TRACES_COLUMN_DEFINITIONS = [
  {
    id: "timestamp",
    name: "Timestamp",
    column: "timestamp",
    filterType: "DateTimeFilter",
  },
  {
    id: "userId",
    name: "User ID",
    column: "user_id",
    filterType: "StringFilter",
  },
  { id: "name", name: "Name", column: "name", filterType: "StringFilter" },
  {
    id: "environment",
    name: "Environment",
    column: "environment",
    filterType: "StringOptionsFilter",
  },
  {
    id: "metadata",
    name: "Metadata",
    column: "metadata",
    filterType: "StringObjectFilter",
  },
  {
    id: "sessionId",
    name: "Session ID",
    column: "session_id",
    filterType: "StringFilter",
  },
  {
    id: "version",
    name: "Version",
    column: "version",
    filterType: "StringFilter",
  },
  {
    id: "release",
    name: "Release",
    column: "release",
    filterType: "StringFilter",
  },
  {
    id: "tags",
    name: "Tags",
    column: "tags",
    filterType: "ArrayOptionsFilter",
  },
] as const;

/**
 * Convenience function: Get just the simple filter mappings for public API
 */
export function createPublicApiTracesColumnMapping(
  tableName: "traces",
  tablePrefix: "t",
): ApiColumnMapping[] {
  const timestampColumn = "timestamp";
  const simpleFilters: ApiColumnMapping[] = [];
  for (const def of TRACES_COLUMN_DEFINITIONS) {
    // For timestamp filters, create fromTimestamp and toTimestamp
    if (def.id === "timestamp") {
      simpleFilters.push(
        {
          id: "fromTimestamp",
          analyticsSelect: timestampColumn,
          operator: ">=" as const,
          filterType: def.filterType,
          analyticsTable: tableName,
          analyticsPrefix: tablePrefix,
        },
        {
          id: "toTimestamp",
          analyticsSelect: timestampColumn,
          operator: "<" as const,
          filterType: def.filterType,
          analyticsTable: tableName,
          analyticsPrefix: tablePrefix,
        },
      );
    } else {
      // Regular column mapping for simple filters
      simpleFilters.push({
        id: def.id,
        analyticsSelect: def.column,
        filterType: def.filterType,
        analyticsTable: tableName,
        analyticsPrefix: tablePrefix,
      });
    }
  }
  return simpleFilters;
}

/**
 * Factory function to create public API column mappings for events/observations tables.
 * Eliminates duplication between events and observations filter mappings.
 */
export function createPublicApiObservationsColumnMapping(
  tableName: "events_proto" | "observations",
  tablePrefix: "e" | "o",
  parentFieldName: "parent_span_id" | "parent_observation_id",
): ApiColumnMapping[] {
  // user_id and session_id are denormalized onto events_core/events_full, so
  // the events_proto path filters directly without joining the traces CTE.
  // The legacy observations table does not carry either field, so that path
  // still joins traces.
  const traceFieldMapping =
    tableName === "events_proto"
      ? {
          analyticsTable: tableName,
          analyticsPrefix: tablePrefix,
        }
      : {
          analyticsTable: "traces",
          analyticsPrefix: "t",
        };
  const userIdMapping: ApiColumnMapping = {
    id: "userId",
    analyticsSelect: "user_id",
    filterType: "StringFilter",
    ...traceFieldMapping,
  };
  const sessionIdMapping: ApiColumnMapping = {
    id: "sessionId",
    analyticsSelect: "session_id",
    filterType: "StringFilter",
    ...traceFieldMapping,
  };
  return [
    userIdMapping,
    sessionIdMapping,
    {
      id: "traceId",
      analyticsSelect: "trace_id",
      filterType: "StringFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    {
      id: "name",
      analyticsSelect: "name",
      filterType: "StringFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    {
      id: "level",
      analyticsSelect: "level",
      filterType: "StringFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    {
      id: "type",
      analyticsSelect: "type",
      filterType: "StringFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    {
      id: "parentObservationId",
      analyticsSelect: parentFieldName,
      filterType: "StringFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    ...(tableName === "events_proto"
      ? [
          {
            id: "isRootObservation",
            analyticsSelect: eventsTableIsRootObservationSql,
            filterType: "BooleanFilter",
            analyticsTable: tableName,
          },
        ]
      : []),
    {
      id: "fromStartTime",
      analyticsSelect: "start_time",
      operator: ">=",
      filterType: "DateTimeFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    {
      id: "toStartTime",
      analyticsSelect: "start_time",
      operator: "<",
      filterType: "DateTimeFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    {
      id: "version",
      analyticsSelect: "version",
      filterType: "StringFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
    {
      id: "environment",
      analyticsSelect: "environment",
      filterType: "StringOptionsFilter",
      analyticsTable: tableName,
      analyticsPrefix: tablePrefix,
    },
  ];
}

type BaseQueryType = {
  page: number;
  limit: number;
  projectId: string;
} & Record<string, unknown>;

export function convertApiProvidedFilterToClickhouseFilter(
  filter: BaseQueryType,
  columnMapping: ApiColumnMapping[],
) {
  const filterList = new FilterList();

  columnMapping.forEach((columnMapping) => {
    const value = filter[columnMapping.id as keyof BaseQueryType];

    if (value !== undefined) {
      let filterInstance;
      switch (columnMapping.filterType) {
        case "DateTimeFilter": {
          // The operator of a datetime column is fixed in the column mapping
          // (e.g. fromTimestamp => ">=", toTimestamp => "<"). The user-provided
          // `operator` query param targets the value filter and must not
          // override it (#8630).
          const finalOperator = columnMapping.operator;

          finalOperator &&
          typeof value === "string" &&
          ["<", "<=", ">", ">="].includes(finalOperator)
            ? (filterInstance = new DateTimeFilter({
                analyticsTable: columnMapping.analyticsTable,
                field: columnMapping.analyticsSelect,
                operator: finalOperator as "<" | "<=" | ">" | ">=",
                value: new Date(value),
                tablePrefix: columnMapping.analyticsPrefix,
              }))
            : undefined;

          break;
        }
        case "ArrayOptionsFilter":
          if (Array.isArray(value) || typeof value === "string") {
            filterInstance = new ArrayOptionsFilter({
              analyticsTable: columnMapping.analyticsTable,
              field: columnMapping.analyticsSelect,
              operator: "all of",
              values: Array.isArray(value) ? value : value.split(","),
              tablePrefix: columnMapping.analyticsPrefix,
            });
          }
          break;
        case "StringOptionsFilter":
          if (Array.isArray(value) || typeof value === "string") {
            filterInstance = new StringOptionsFilter({
              analyticsTable: columnMapping.analyticsTable,
              field: columnMapping.analyticsSelect,
              operator: "any of",
              values: Array.isArray(value) ? value : value.split(","),
              tablePrefix: columnMapping.analyticsPrefix,
            });
          }
          break;
        case "CategoryOptionsFilter":
          if (Array.isArray(value)) {
            const availableOperatorsCategory = z.enum(
              filterOperators.categoryOptions,
            );
            const parsedOperatorCategory = availableOperatorsCategory.safeParse(
              filter.operator,
            );

            if (
              parsedOperatorCategory.success &&
              typeof filter.key === "string"
            ) {
              filterInstance = new CategoryOptionsFilter({
                analyticsTable: columnMapping.analyticsTable,
                field: columnMapping.analyticsSelect,
                key: filter.key,
                operator: parsedOperatorCategory.data,
                values: value,
                tablePrefix: columnMapping.analyticsPrefix,
              });
            }
          }
          break;

        case "StringFilter":
          if (typeof value === "string") {
            filterInstance = new StringFilter({
              analyticsTable: columnMapping.analyticsTable,
              field: columnMapping.analyticsSelect,
              operator: "=",
              value: value,
              tablePrefix: columnMapping.analyticsPrefix,
            });
          }
          break;
        case "NumberFilter": {
          const availableOperatorsNum = z.enum([
            ...filterOperators.number,
            "!=",
          ]);
          const parsedOperatorNum = availableOperatorsNum.safeParse(
            filter.operator,
          );

          if (parsedOperatorNum.success) {
            filterInstance = new NumberFilter({
              analyticsTable: columnMapping.analyticsTable,
              field: columnMapping.analyticsSelect,
              operator: parsedOperatorNum.data,
              value: Number(value),
              tablePrefix: columnMapping.analyticsPrefix,
            });
          }
          break;
        }
        case "BooleanFilter":
          if (typeof value === "boolean") {
            filterInstance = new BooleanFilter({
              analyticsTable: columnMapping.analyticsTable,
              field: columnMapping.analyticsSelect,
              operator: "=",
              value,
              tablePrefix: columnMapping.analyticsPrefix,
            });
          }
          break;
      }

      filterInstance && filterList.push(filterInstance);
    }
  });

  return filterList;
}

/**
 * Derives a merged FilterList from simple API parameters and advanced filter JSON.
 * Advanced filters take precedence over simple filters when targeting the same field.
 *
 * @param simpleFilterProps - Object containing simple query parameters (e.g., { userId: "123", name: "test" })
 * @param filterParamsMapping - Column mapping configuration for simple filters
 * @param advancedFilters - Optional array of FilterState objects from JSON filter parameter
 * @param uiColumnDefinitions - UI column definitions for advanced filter conversion
 * @returns Merged FilterList with advanced filters taking precedence
 */
export function deriveFilters<T extends BaseQueryType>(
  simpleFilterProps: T,
  filterParamsMapping: ApiColumnMapping[],
  advancedFilters: EventsTableFilterState | undefined,
  uiColumnDefinitions: UiColumnMappings,
  columnDefinitions?: ColumnDefinition[],
): FilterList {
  // Start with advanced filters converted to FilterList
  const filterList = new FilterList(
    createFilterFromFilterState(
      advancedFilters ?? [],
      uiColumnDefinitions,
      columnDefinitions,
    ),
  );

  // Convert simple parameters to filters
  const simpleFilters = convertApiProvidedFilterToClickhouseFilter(
    simpleFilterProps,
    filterParamsMapping,
  );

  // tablePrefix is a query alias, not part of a physical column identity.
  simpleFilters
    .filter(
      (simpleFilter) =>
        !filterList.some(
          (advancedFilter) =>
            advancedFilter.analyticsTable === simpleFilter.analyticsTable &&
            advancedFilter.field === simpleFilter.field,
        ),
    )
    .forEach((f) => filterList.push(f));

  // Return merged filters
  return filterList;
}
