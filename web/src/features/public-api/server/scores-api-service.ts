import { randomUUID } from "crypto";

import {
  _handleGenerateScoresForPublicApi,
  _handleGetScoresCountForPublicApi,
  convertScoreToPublicApi,
  type ScoreQueryType,
} from "@/src/features/public-api/server/scores";
import { auditLog } from "@/src/features/audit-logs/server";
import {
  InternalServerError,
  LISTABLE_SCORE_TYPES,
  type ScoreSourceType,
  type PostScoresBodyV1,
  scoresTableCols,
  type ScoreDataTypeType,
} from "@langfuse/shared";
import {
  _handleGetScoreById,
  eventTypes,
  processEventBatch,
  QueueJobs,
  ScoreDeleteQueue,
  type AuthHeaderValidVerificationResultIngestion,
  type IngestionAttribution,
  StringFilter,
  StringOptionsFilter,
  type FilterList,
  deriveFilters,
  convertApiProvidedFilterToClickhouseFilter,
  scoresTableUiColumnDefinitions,
} from "@langfuse/shared/src/server";
import type { z } from "zod";

const secureScoreFilterOptions = [
  {
    id: "traceId",
    analyticsSelect: "trace_id",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "observationId",
    analyticsSelect: "observation_id",
    analyticsTable: "scores",
    filterType: "StringOptionsFilter",
    clickhousePrefix: "s",
  },
  {
    id: "name",
    analyticsSelect: "name",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "source",
    analyticsSelect: "source",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "fromTimestamp",
    analyticsSelect: "timestamp",
    operator: ">=" as const,
    analyticsTable: "scores",
    filterType: "DateTimeFilter",
    clickhousePrefix: "s",
  },
  {
    id: "toTimestamp",
    analyticsSelect: "timestamp",
    operator: "<" as const,
    analyticsTable: "scores",
    filterType: "DateTimeFilter",
    clickhousePrefix: "s",
  },
  {
    id: "value",
    analyticsSelect: "value",
    analyticsTable: "scores",
    filterType: "NumberFilter",
    clickhousePrefix: "s",
  },
  {
    id: "scoreIds",
    analyticsSelect: "id",
    analyticsTable: "scores",
    filterType: "StringOptionsFilter",
    clickhousePrefix: "s",
  },
  {
    id: "configId",
    analyticsSelect: "config_id",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "sessionId",
    analyticsSelect: "session_id",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "datasetRunId",
    analyticsSelect: "dataset_run_id",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "queueId",
    analyticsSelect: "queue_id",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
  {
    id: "environment",
    analyticsSelect: "environment",
    analyticsTable: "scores",
    filterType: "StringOptionsFilter",
    clickhousePrefix: "s",
  },
  {
    id: "dataType",
    analyticsSelect: "data_type",
    analyticsTable: "scores",
    filterType: "StringFilter",
    clickhousePrefix: "s",
  },
];

const secureTraceFilterOptions = [
  {
    id: "traceTags",
    analyticsSelect: "tags",
    analyticsTable: "traces",
    filterType: "ArrayOptionsFilter",
    clickhousePrefix: "t",
  },
  {
    id: "userId",
    analyticsSelect: "user_id",
    analyticsTable: "traces",
    filterType: "StringFilter",
    clickhousePrefix: "t",
  },
];

function buildScoreFilters(
  props: ScoreQueryType,
  scoreDataTypes?: readonly ScoreDataTypeType[],
): { scoresFilter: FilterList; tracesFilter: FilterList } {
  const scoresFilter = deriveFilters(
    props,
    secureScoreFilterOptions,
    props.advancedFilters,
    scoresTableUiColumnDefinitions,
    scoresTableCols,
  );
  scoresFilter.push(
    new StringFilter({
      analyticsTable: "scores",
      field: "project_id",
      operator: "=",
      value: props.projectId,
    }),
  );

  if (scoreDataTypes) {
    scoresFilter.push(
      new StringOptionsFilter({
        analyticsTable: "scores",
        field: "data_type",
        operator: "any of",
        values: [...scoreDataTypes],
        tablePrefix: "s",
      }),
    );
  }

  const tracesFilter = convertApiProvidedFilterToClickhouseFilter(
    props,
    secureTraceFilterOptions,
  );

  if (props.environment && tracesFilter.length() > 0) {
    const envValues = Array.isArray(props.environment)
      ? props.environment
      : [props.environment];
    tracesFilter.push(
      new StringOptionsFilter({
        analyticsTable: "traces",
        field: "environment",
        operator: "any of",
        values: envValues,
        tablePrefix: "t",
      }),
    );
  }

  return { scoresFilter, tracesFilter };
}

function determineTraceJoinRequirement(
  fields: string[] | null | undefined,
  tracesFilterLength: number,
) {
  const requestedFields = fields ?? ["score", "trace"];
  const includeTrace = requestedFields.includes("trace");
  const needsTraceJoin = includeTrace || tracesFilterLength > 0;
  return { includeTrace, needsTraceJoin };
}

export class ScoresApiService {
  constructor(private readonly apiVersion: "v1" | "v2") {}

  async createScore({
    body,
    auth,
    auditScope,
    scoreId = body.id ?? randomUUID(),
    attribution,
  }: {
    body: z.infer<typeof PostScoresBodyV1>;
    auth: AuthHeaderValidVerificationResultIngestion;
    auditScope?: { projectId: string; orgId: string; apiKeyId: string };
    scoreId?: string;
    attribution: IngestionAttribution;
  }) {
    const existingScore = auditScope
      ? await _handleGetScoreById({
          projectId: auditScope.projectId,
          scoreId,
          scoreScope: this.apiVersion === "v1" ? "traces_only" : "all",
          scoreDataTypes:
            this.apiVersion === "v1" ? LISTABLE_SCORE_TYPES : undefined,
          preferredClickhouseService: "ReadOnly",
          apiVersion: this.apiVersion,
        })
      : undefined;

    const result = await processEventBatch(
      [
        {
          id: randomUUID(),
          type: eventTypes.SCORE_CREATE,
          timestamp: new Date().toISOString(),
          body: { ...body, id: scoreId },
        },
      ],
      auth,
      { attribution },
    );

    if (
      auditScope &&
      result.errors.length === 0 &&
      result.successes.length === 1
    ) {
      await auditLog({
        action: existingScore ? "update" : "create",
        resourceType: "score",
        resourceId: scoreId,
        projectId: auditScope.projectId,
        orgId: auditScope.orgId,
        apiKeyId: auditScope.apiKeyId,
        before: existingScore
          ? convertScoreToPublicApi(existingScore)
          : undefined,
        after: { ...body, id: scoreId },
      });
    }

    return { id: scoreId, result };
  }

  async deleteScore({
    projectId,
    orgId,
    apiKeyId,
    scoreId,
  }: {
    projectId: string;
    orgId: string;
    apiKeyId: string;
    scoreId: string;
  }) {
    const scoreDeleteQueue = ScoreDeleteQueue.getInstance();
    if (!scoreDeleteQueue) {
      throw new InternalServerError("ScoreDeleteQueue not initialized");
    }

    await auditLog({
      action: "delete",
      resourceType: "score",
      resourceId: scoreId,
      projectId,
      orgId,
      apiKeyId,
    });

    await scoreDeleteQueue.add(QueueJobs.ScoreDelete, {
      timestamp: new Date(),
      id: randomUUID(),
      payload: {
        projectId,
        scoreIds: [scoreId],
      },
      name: QueueJobs.ScoreDelete,
    });

    return { message: "Score deletion queued successfully" };
  }

  /**
   * Get a specific score by ID
   * v1: Returns listable scores (NUMERIC, BOOLEAN, CATEGORICAL, TEXT) - excludes CORRECTION
   * v2: Returns all score types including CORRECTION and TEXT
   */
  async getScoreById({
    projectId,
    scoreId,
    source,
  }: {
    projectId: string;
    scoreId: string;
    source?: ScoreSourceType;
  }) {
    const score = await _handleGetScoreById({
      projectId,
      scoreId,
      source,
      scoreScope: this.apiVersion === "v1" ? "traces_only" : "all",
      scoreDataTypes:
        this.apiVersion === "v1" ? LISTABLE_SCORE_TYPES : undefined,
      preferredClickhouseService: "ReadOnly",
      apiVersion: this.apiVersion,
    });

    if (!score) {
      return undefined;
    }

    return convertScoreToPublicApi(score);
  }

  /**
   * Get list of scores with version-aware filtering
   * v1: Returns listable scores (NUMERIC, BOOLEAN, CATEGORICAL, TEXT) - excludes CORRECTION
   * v2: Returns all score types including CORRECTION and TEXT
   */
  async generateScoresForPublicApi(props: ScoreQueryType) {
    const scoreDataTypes =
      this.apiVersion === "v1" ? LISTABLE_SCORE_TYPES : undefined;
    const { scoresFilter, tracesFilter } = buildScoreFilters(
      props,
      scoreDataTypes,
    );
    const { includeTrace, needsTraceJoin } = determineTraceJoinRequirement(
      props.fields,
      tracesFilter.length(),
    );
    const results = await _handleGenerateScoresForPublicApi({
      projectId: props.projectId,
      scoresFilter,
      tracesFilter,
      scoreScope: this.apiVersion === "v1" ? "traces_only" : "all",
      includeTrace,
      needsTraceJoin,
      pagination: { limit: props.limit, page: props.page },
      apiVersion: this.apiVersion,
    });
    // Apply API-shape transformation (moves longStringValue→stringValue for
    // CORRECTION, strips longStringValue for others). Must happen here because
    // convertScoreToPublicApi is a web-layer concern that the shared repository
    // function deliberately does not call.
    return results.map(({ trace, ...rest }) => ({
      ...convertScoreToPublicApi(rest),
      trace,
    }));
  }

  /**
   * Get count of scores with version-aware filtering
   * v1: Only counts listable scores (NUMERIC, BOOLEAN, CATEGORICAL, TEXT) - excludes CORRECTION
   * v2: Counts all score types including CORRECTION and TEXT
   */
  async getScoresCountForPublicApi(props: ScoreQueryType) {
    const scoreDataTypes =
      this.apiVersion === "v1" ? LISTABLE_SCORE_TYPES : undefined;
    const { scoresFilter, tracesFilter } = buildScoreFilters(
      props,
      scoreDataTypes,
    );
    const { includeTrace, needsTraceJoin } = determineTraceJoinRequirement(
      props.fields,
      tracesFilter.length(),
    );
    return _handleGetScoresCountForPublicApi({
      projectId: props.projectId,
      scoresFilter,
      tracesFilter,
      scoreScope: this.apiVersion === "v1" ? "traces_only" : "all",
      includeTrace,
      needsTraceJoin,
      apiVersion: this.apiVersion,
    });
  }
}
