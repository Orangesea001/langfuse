/* eslint-disable @repo/no-exotic-operators */
import {
  TraceRecordInsertType,
  ObservationRecordInsertType,
  ScoreRecordInsertType,
  DatasetRunItemRecordInsertType,
  createDatasetRunItemsCh,
  createTracesCh,
  createObservationsCh,
  createScoresCh,
} from "../../../src/server";
// InsertResult from @analytics/client removed (MySQL backend)
type InsertResult = unknown;

/**
 * Builds or executes Analytics SQL INSERT queries for seeding test data.
 *
 * Use executeXxxInsert() for custom curated data with detailed control.
 * Use buildBulkXxxInsert() for large datasets (>1000 items) for random distribution of data.
 */
export class AnalyticsQueryBuilder {
  private escapeString(str: string): string {
    // Backslashes first: Analytics treats them as escape sequences inside
    // single-quoted literals, so unescaped ones corrupt the stored value or
    // break the statement (e.g. a JSON fixture's \" or an --id-prefix 'a\').
    return str.replace(/\\/g, "\\\\").replace(/'/g, "''");
  }

  private buildNestedMetadataMapSql(
    baseEntries: string[],
    rowExpression = "number",
  ): string {
    return `map(
          ${baseEntries.join(",\n          ")},
          'customer.id', concat('customer_', toString(${rowExpression} % 100)),
          'customer.plan', arrayElement(['free', 'pro', 'enterprise'], 1 + (${rowExpression} % 3)),
          'customer.region.code', arrayElement(['eu-central-1', 'us-east-1', 'ap-south-1'], 1 + (${rowExpression} % 3)),
          'routing.queue', arrayElement(['support-chat', 'sales-chat', 'ops-chat'], 1 + (${rowExpression} % 3)),
          'routing.priority', arrayElement(['low', 'normal', 'high'], 1 + (${rowExpression} % 3)),
          'flags.beta', if(${rowExpression} % 2 = 0, 'true', 'false')
        )`;
  }

  /**
   * Creates INSERT query for trace data using VALUES syntax.
   * Use for: Small datasets, detailed trace objects with all fields populated.
   */
  async executeTracesInsert(
    traces: TraceRecordInsertType[],
  ): Promise<InsertResult> {
    return await createTracesCh(traces);
  }

  /**
   * Creates INSERT query for observation data using VALUES syntax.
   * Use for: Small datasets, observations that link to postgres data (e.g. dataset runs)
   */
  async executeObservationsInsert(
    observations: ObservationRecordInsertType[],
  ): Promise<InsertResult> {
    return await createObservationsCh(observations);
  }

  /**
   * Creates INSERT query for dataset run items data using VALUES syntax.
   * Use for: Small datasets, dataset run items that link to postgres data (e.g. dataset runs)
   */
  async executeDatasetRunItemsInsert(
    datasetRunItems: DatasetRunItemRecordInsertType[],
  ): Promise<InsertResult> {
    return await createDatasetRunItemsCh(datasetRunItems);
  }

  /**
   * Creates INSERT query for score data using VALUES syntax.
   * Use for: Small datasets, scores with custom values and metadata.
   */
  async executeScoresInsert(
    scores: ScoreRecordInsertType[],
  ): Promise<InsertResult> {
    return await createScoresCh(scores);
  }

  /**
   * Creates INSERT using Analytics numbers() function.
   * Use for: Large datasets (>1000 traces), realistic timestamps, bulk generation.
   */
  /**
   * Bulk-insert traces using JavaScript data generation (MySQL-compatible).
   * Replaces ClickHouse INSERT...SELECT FROM numbers() approach.
   */
  async executeBulkTracesInsert(
    projectId: string,
    count: number,
    environment = "default",
    fileContent?: { heavyMarkdown: string; nestedJson: any; chatMlJson: any },
    opts: {
      numberOfDays: number;
      idPrefix?: string;
      anchorSeconds?: number;
      seed?: number;
    } = { numberOfDays: 1 },
  ): Promise<void> {
    const idPrefix = opts.idPrefix ? `${opts.idPrefix}-` : "";
    const idSuffix = projectId.slice(-8);
    const spreadSeconds = opts.numberOfDays * 86400;
    const anchorSeconds =
      opts.anchorSeconds ?? Math.floor(Date.now() / 86_400_000) * 86_400;
    const names = [
      "chat-completion",
      "summarize-document",
      "extract-entities",
      "embed-documents",
      "classify-intent",
      "generate-title",
      "translate-text",
      "moderate-content",
      "rerank-results",
      "answer-question",
    ];

    const traces: TraceRecordInsertType[] = [];
    for (let i = 0; i < count; i++) {
      const ts = new Date(
        (anchorSeconds - Math.floor((i * spreadSeconds) / Math.max(count, 1))) *
          1000,
      );
      const tsStr = ts.toISOString().replace("T", " ").replace("Z", "");
      const name = names[i % names.length];
      const userId =
        Math.random() < 0.3 ? `user_${Math.floor(Math.random() * 1000)}` : null;
      const sessionId =
        Math.random() < 0.3
          ? `session_${Math.floor(Math.random() * 100)}`
          : null;
      const input = fileContent
        ? Math.random() < 0.3
          ? fileContent.heavyMarkdown
          : JSON.stringify(fileContent.chatMlJson)
        : null;
      const output = fileContent
        ? Math.random() < 0.2
          ? JSON.stringify(fileContent.nestedJson)
          : JSON.stringify(fileContent.chatMlJson)
        : null;

      traces.push({
        id: `${idPrefix}trace-bulk-${i}-${idSuffix}`,
        name,
        user_id: userId,
        metadata: { generated: "true", source: "bulk" },
        release: null,
        version: null,
        project_id: projectId,
        environment,
        public: Math.random() < 0.1,
        bookmarked: Math.random() < 0.05,
        tags: [],
        input,
        output,
        session_id: sessionId,
        timestamp: tsStr,
        created_at: tsStr,
        updated_at: tsStr,
        event_ts: new Date().toISOString().replace("T", " ").replace("Z", ""),
        is_deleted: 0,
      });
    }

    // Insert in batches of 1000
    const batchSize = 1000;
    for (let i = 0; i < traces.length; i += batchSize) {
      await createTracesCh(traces.slice(i, i + batchSize));
    }
  }

  /**
   * Bulk-insert observations using JavaScript data generation (MySQL-compatible).
   */
  async executeBulkObservationsInsert(
    projectId: string,
    tracesCount: number,
    observationsPerTrace = 5,
    environment = "default",
    fileContent?: { heavyMarkdown: string; nestedJson: any; chatMlJson: any },
    opts: {
      numberOfDays: number;
      idPrefix?: string;
      anchorSeconds?: number;
      seed?: number;
      observationsPerTrace?: number;
    } = { numberOfDays: 1 },
  ): Promise<void> {
    const idPrefix = opts.idPrefix ? `${opts.idPrefix}-` : "";
    const idSuffix = projectId.slice(-8);
    const totalObservations = tracesCount * observationsPerTrace;
    const models = [
      "gpt-4o-mini",
      "gpt-4-turbo",
      "claude-3-haiku",
      "gpt-4",
      "claude-3-sonnet",
    ];
    const types = ["GENERATION", "SPAN", "EVENT"] as const;

    const observations: ObservationRecordInsertType[] = [];
    for (let i = 0; i < totalObservations; i++) {
      const traceIdx = i % tracesCount;
      const typeIdx = Math.floor(Math.random() * 100);
      const type =
        typeIdx < 47 ? "GENERATION" : typeIdx < 94 ? "SPAN" : "EVENT";
      const parentId =
        i >= tracesCount
          ? `${idPrefix}obs-bulk-${i - tracesCount}-${idSuffix}`
          : null;
      const ts = new Date(
        Date.now() -
          Math.floor((traceIdx * 86400 * opts.numberOfDays) / tracesCount) *
            1000,
      );
      const tsStr = ts.toISOString().replace("T", " ").replace("Z", "");
      const endTime = new Date(ts.getTime() + (Math.random() * 3000 + 100));
      const model =
        type === "GENERATION"
          ? models[Math.floor(Math.random() * models.length)]
          : null;
      const inputTokens =
        type === "GENERATION" ? Math.floor(Math.random() * 181) + 20 : 0;
      const outputTokens =
        type === "GENERATION" ? Math.floor(Math.random() * 91) + 10 : 0;
      const totalTokens = inputTokens + outputTokens;

      observations.push({
        id: `${idPrefix}obs-bulk-${i}-${idSuffix}`,
        trace_id: `${idPrefix}trace-bulk-${traceIdx}-${idSuffix}`,
        project_id: projectId,
        environment,
        type: type as "GENERATION" | "SPAN" | "EVENT",
        parent_observation_id: parentId,
        start_time: tsStr,
        end_time: endTime.toISOString().replace("T", " ").replace("Z", ""),
        name: `${type.toLowerCase()}-${i % 10}`,
        metadata: {},
        level: "DEFAULT",
        status_message: null,
        version: null,
        input:
          type === "GENERATION" && fileContent
            ? JSON.stringify(fileContent.chatMlJson)
            : null,
        output:
          type === "GENERATION" && fileContent
            ? JSON.stringify(fileContent.nestedJson)
            : null,
        provided_model_name: model,
        internal_model_id: null,
        model_parameters: type === "GENERATION" ? '{"temperature": 0.7}' : "{}",
        provided_usage_details:
          type === "GENERATION"
            ? { input: inputTokens, output: outputTokens, total: totalTokens }
            : {},
        usage_details:
          type === "GENERATION"
            ? { input: inputTokens, output: outputTokens, total: totalTokens }
            : {},
        provided_cost_details: {},
        cost_details: {},
        total_cost: null,
        completion_start_time: null,
        prompt_id: null,
        prompt_name: null,
        prompt_version: null,
        created_at: tsStr,
        updated_at: tsStr,
        event_ts: new Date().toISOString().replace("T", " ").replace("Z", ""),
        is_deleted: 0,
        usage_pricing_tier_id: "",
        usage_pricing_tier_name: "",
        tool_definitions: {},
        tool_calls: [],
        tool_call_names: [],
      });
    }

    const batchSize = 1000;
    for (let i = 0; i < observations.length; i += batchSize) {
      await createObservationsCh(observations.slice(i, i + batchSize));
    }
  }

  /**
   * Bulk-insert scores using JavaScript data generation (MySQL-compatible).
   */
  async executeBulkScoresInsert(
    projectId: string,
    tracesCount: number,
    scoresPerTrace = 2,
    environment = "default",
    opts: {
      numberOfDays: number;
      idPrefix?: string;
      anchorSeconds?: number;
      seed?: number;
      observationsPerTrace?: number;
    } = { numberOfDays: 1 },
  ): Promise<void> {
    const idPrefix = opts.idPrefix ? `${opts.idPrefix}-` : "";
    const idSuffix = projectId.slice(-8);
    const totalScores = tracesCount * scoresPerTrace;
    const scoreNames = [
      "metric_1",
      "metric_2",
      "metric_3",
      "metric_4",
      "metric_5",
    ];
    const dataTypes = ["NUMERIC", "BOOLEAN", "CATEGORICAL"] as const;
    const sources = ["API"] as const;
    const sdkNames = ["python", "javascript", "unknown"];

    const scores: ScoreRecordInsertType[] = [];
    for (let i = 0; i < totalScores; i++) {
      const traceIdx = i % tracesCount;
      const ts = new Date(
        Date.now() -
          Math.floor((traceIdx * 86400 * opts.numberOfDays) / tracesCount) *
            1000 +
          Math.floor(i / tracesCount) * 90000,
      );
      const tsStr = ts.toISOString().replace("T", " ").replace("Z", "");
      const nameKey = i % 5;
      const name = scoreNames[nameKey];
      const dataTypeIdx = nameKey % 3;
      const dataType = dataTypes[dataTypeIdx];
      const value =
        dataType === "NUMERIC"
          ? Math.random() * 100
          : dataType === "BOOLEAN"
            ? Math.random() < 0.5
              ? 1
              : 0
            : 0;
      const stringValue =
        dataType === "BOOLEAN"
          ? value === 1
            ? "True"
            : "False"
          : dataType === "CATEGORICAL"
            ? `category_${Math.floor(Math.random() * 5) + 1}`
            : null;

      scores.push({
        id: `${idPrefix}score-bulk-${i}-${idSuffix}`,
        timestamp: tsStr,
        project_id: projectId,
        environment,
        trace_id: `${idPrefix}trace-bulk-${traceIdx}-${idSuffix}`,
        observation_id: null,
        name,
        value,
        source: "API",
        comment: "Generated synthetic score",
        metadata: {},
        data_type: dataType,
        string_value: stringValue,
        created_at: tsStr,
        updated_at: tsStr,
        event_ts: new Date().toISOString().replace("T", " ").replace("Z", ""),
        is_deleted: 0,
        author_user_id: null,
        config_id: null,
        dataset_run_id: null,
        queue_id: null,
        long_string_value: "",
        evaluator_id: "",
        evaluation_rule_id: "",
        session_id: null,
      });
    }

    const batchSize = 1000;
    for (let i = 0; i < scores.length; i += batchSize) {
      await createScoresCh(scores.slice(i, i + batchSize));
    }
  }
}
