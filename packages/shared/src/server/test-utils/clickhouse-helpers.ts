import { upsertClickhouse } from "../repositories/clickhouse";
import {
  TraceRecordInsertType,
  ObservationRecordInsertType,
  ScoreRecordInsertType,
  DatasetRunItemRecordInsertType,
  EventRecordInsertType,
} from "../repositories/definitions";

export const createTracesCh = async (trace: TraceRecordInsertType[]) => {
  return await upsertClickhouse({
    table: "traces",
    records: trace as Record<string, unknown>[],
  });
};

export const createObservationsCh = async (
  observations: ObservationRecordInsertType[],
) => {
  return await upsertClickhouse({
    table: "observations",
    records: observations as Record<string, unknown>[],
  });
};

export const createEventsCh = async (events: EventRecordInsertType[]) => {
  return await upsertClickhouse({
    table: "events_full",
    records: events as Record<string, unknown>[],
  });
};

export const createScoresCh = async (scores: ScoreRecordInsertType[]) => {
  return await upsertClickhouse({
    table: "scores",
    records: scores as Record<string, unknown>[],
  });
};

export const createDatasetRunItemsCh = async (
  datasetRunItems: DatasetRunItemRecordInsertType[],
) => {
  return await upsertClickhouse({
    table: "dataset_run_items_rmt",
    records: datasetRunItems as Record<string, unknown>[],
  });
};
