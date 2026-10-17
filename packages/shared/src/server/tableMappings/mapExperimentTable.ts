import type {
  ColumnDefinition,
  UiColumnMappings,
} from "../../tableDefinitions";
import type { ApiColumnMapping } from "../queries/public-api-filter-builder";

/**
 * Pre-aggregation column mappings for experiments.
 *
 * These columns exist in the raw events table and can be filtered BEFORE
 * the experiment_data CTE aggregation for better query performance.
 *
 * Used for filtering raw events before GROUP BY.
 */
export const experimentPreAggCols: UiColumnMappings = [
  {
    uiTableName: "ID",
    uiTableId: "id",
    analyticsTableName: "events_proto",
    analyticsSelect: "e.experiment_id",
  },
  {
    uiTableName: "Name",
    uiTableId: "name",
    analyticsTableName: "events_proto",
    analyticsSelect: "e.experiment_name",
  },
  {
    uiTableName: "Description",
    uiTableId: "description",
    analyticsTableName: "events_proto",
    analyticsSelect: "e.experiment_description",
  },
  {
    uiTableName: "Dataset ID",
    uiTableId: "experimentDatasetId",
    analyticsTableName: "events_proto",
    analyticsSelect: "e.experiment_dataset_id",
  },
  {
    uiTableName: "Start Time",
    uiTableId: "startTime",
    analyticsTableName: "events_proto",
    analyticsSelect: "e.start_time",
  },
  {
    uiTableName: "Metadata",
    uiTableId: "metadata",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_metadata",
    queryPrefix: "e", // StringObjectFilter uses {prefix}.{field}_names/{field}_values for array access
  },
];

/**
 * Score aggregation column mappings for experiments.
 */
export const experimentScoreAggCols: UiColumnMappings = [
  // Level-agnostic scores: these match a score whether it was recorded on an
  // observation or on the trace. The legacy `obs_*` ids map here too, so links
  // and saved views written against them keep working — and start matching
  // trace-level scores, which is the point (a score recorded on the trace used
  // to return nothing).
  {
    uiTableName: "Scores (numeric)",
    uiTableId: "scores_avg",
    analyticsTableName: "scores",
    analyticsSelect: "scores_avg",
    aliases: ["obs_scores_avg"],
  },
  {
    uiTableName: "Scores (categorical)",
    uiTableId: "score_categories",
    analyticsTableName: "scores",
    analyticsSelect: "score_categories",
    aliases: ["obs_score_categories"],
  },
  {
    uiTableName: "Scores (boolean)",
    uiTableId: "score_booleans",
    analyticsTableName: "scores",
    analyticsSelect: "score_booleans",
    aliases: ["obs_score_booleans"],
  },
  // Trace-only, kept resolving for saved views that deliberately scoped to the
  // trace level. Not offered as a facet: aliasing these onto the agnostic
  // arrays would silently WIDEN such a filter.
  {
    uiTableName: "Trace Scores (numeric)",
    uiTableId: "trace_scores_avg",
    analyticsTableName: "scores",
    analyticsSelect: "trace_scores_avg",
  },
  {
    uiTableName: "Trace Scores (categorical)",
    uiTableId: "trace_score_categories",
    analyticsTableName: "scores",
    analyticsSelect: "trace_score_categories",
  },
  {
    uiTableName: "Trace Scores (boolean)",
    uiTableId: "trace_score_booleans",
    analyticsTableName: "scores",
    analyticsSelect: "trace_score_booleans",
  },
];

export const experimentOrderByCols: UiColumnMappings = [
  {
    uiTableName: "Start Time",
    uiTableId: "startTime",
    analyticsTableName: "events_proto",
    analyticsSelect: "start_time",
  },
];

/**
 * Combined column mappings for experiments (all columns).
 * Used for general column lookups.
 */
export const experimentCols: UiColumnMappings = [
  ...experimentPreAggCols,
  ...experimentScoreAggCols,
];

const publicApiExperimentFilterColumns = [
  {
    id: "id",
    uiTableName: "ID",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_id",
    nullable: false,
  },
  {
    id: "name",
    uiTableName: "Name",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_name",
    nullable: true,
  },
  {
    id: "datasetId",
    uiTableName: "Dataset ID",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_dataset_id",
    nullable: true,
  },
] as const;

export const publicApiExperimentSimpleFilterMappings: ApiColumnMapping[] =
  publicApiExperimentFilterColumns.map((column) => ({
    id: column.id,
    analyticsSelect: column.analyticsSelect,
    analyticsTable: column.analyticsTableName,
    filterType: "StringOptionsFilter",
    analyticsPrefix: "e",
  }));

export const publicApiExperimentColumnMappings: UiColumnMappings =
  publicApiExperimentFilterColumns.map((column) => ({
    uiTableName: column.uiTableName,
    uiTableId: column.id,
    analyticsTableName: column.analyticsTableName,
    analyticsSelect: column.analyticsSelect,
    queryPrefix: "e",
  }));

export const publicApiExperimentColumnDefinitions: ColumnDefinition[] =
  publicApiExperimentFilterColumns.map((column) => ({
    name: column.uiTableName,
    id: column.id,
    type: "stringOptions",
    internal: column.analyticsSelect,
    options: [],
    ...(column.nullable ? { nullable: true } : {}),
  }));

const publicApiExperimentItemFilterColumns = [
  {
    id: "experimentId",
    uiTableName: "ID",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_id",
    nullable: false,
  },
  {
    id: "experimentName",
    uiTableName: "Name",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_name",
    nullable: true,
  },
  {
    id: "experimentItemId",
    uiTableName: "Experiment Item ID",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_item_id",
    nullable: false,
  },
  {
    id: "datasetId",
    uiTableName: "Dataset ID",
    analyticsTableName: "events_proto",
    analyticsSelect: "experiment_dataset_id",
    nullable: true,
  },
] as const;

export const publicApiExperimentItemSimpleFilterMappings: ApiColumnMapping[] =
  publicApiExperimentItemFilterColumns.map((column) => ({
    id: column.id,
    analyticsSelect: column.analyticsSelect,
    analyticsTable: column.analyticsTableName,
    filterType: "StringOptionsFilter",
    analyticsPrefix: "e",
  }));

export const publicApiExperimentItemColumnMappings: UiColumnMappings =
  publicApiExperimentItemFilterColumns.map((column) => ({
    uiTableName: column.uiTableName,
    uiTableId: column.id,
    analyticsTableName: column.analyticsTableName,
    analyticsSelect: column.analyticsSelect,
    queryPrefix: "e",
  }));

export const publicApiExperimentItemColumnDefinitions: ColumnDefinition[] =
  publicApiExperimentItemFilterColumns.map((column) => ({
    name: column.uiTableName,
    id: column.id,
    type: "stringOptions",
    internal: column.analyticsSelect,
    options: [],
    ...(column.nullable ? { nullable: true } : {}),
  }));
