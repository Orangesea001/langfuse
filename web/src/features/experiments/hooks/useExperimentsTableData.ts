import { useEffect, useMemo, useRef, useState } from "react";
import { type FilterState, type ScoreAggregate } from "@langfuse/shared";
import { api } from "@/src/utils/api";
import { joinTableCoreAndMetrics } from "@/src/components/table/utils/joinTableCoreAndMetrics";

type ExperimentCoreData = {
  id: string;
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  prompts: Array<[string, number | null]>;
  datasetId: string;
  startTime: Date;
  itemCount: number;
  errorCount: number;
};

type ExperimentMetricsData = {
  id: string;
  totalCost: number | null;
  latencyAvg: number | null;
  traceItemScores: ScoreAggregate; // Scores on traces (observation_id IS NULL)
  observationItemScores: ScoreAggregate; // Scores on observations (observation_id IS NOT NULL)
  experimentScores: ScoreAggregate; // Experiment-level scores
};

/**
 * How many runs the empty-window fallback shows: enough to see what the last
 * runs were, few enough that it reads as a fallback rather than a result set.
 */
const MOST_RECENT_FALLBACK_LIMIT = 10;

/**
 * How often the experiments table re-polls while the page is open. Runs are
 * written progressively by the worker (one item per model call, often tens of
 * seconds apart), so a snapshot-only table would keep showing stale item
 * counts until the user manually refreshes.
 */
const RUN_POLL_INTERVAL_MS = 5_000;

/**
 * A run counts as "in progress" while its item/error count is still moving.
 * The grace period bridges the quiet stretch while the worker is still inside
 * a model call for the next item (often 30s+ for reasoning models), so the
 * spinner does not flicker off between two item completions.
 */
const RUNNING_GRACE_MS = 90_000;

type RunActivitySnapshot = {
  itemCount: number;
  errorCount: number;
  lastChangedAt: number;
};

type UseExperimentsTableDataParams = {
  projectId: string;
  filterState: FilterState;
  paginationState: {
    page: number;
    limit: number;
  };
  /**
   * Hold the queries while a filter value still needs translating. A dataset
   * NAME reaches the query as an id, so firing before the name -> id map lands
   * would query a bogus id and show "No experiments" before flipping to the
   * real rows.
   */
  enabled?: boolean;
  orderByState: {
    column: string;
    order: "ASC" | "DESC";
  } | null;
};

export function useExperimentsTableData({
  projectId,
  filterState,
  paginationState,
  orderByState,
  enabled = true,
}: UseExperimentsTableDataParams) {
  // Prepare query payloads
  const getCountPayload = useMemo(
    () => ({
      projectId,
      filter: filterState,
    }),
    [projectId, filterState],
  );

  const getAllPayload = useMemo(
    () => ({
      ...getCountPayload,
      page: paginationState.page - 1, // Backend uses 0-indexed pages
      limit: paginationState.limit,
      orderBy: orderByState,
    }),
    [
      getCountPayload,
      paginationState.page,
      paginationState.limit,
      orderByState,
    ],
  );

  // `projectId` is read from `router.query`, which Next.js populates only after
  // hydration. Without this guard both queries fire with `projectId: undefined`
  // on a cold load and the rejected zod input surfaces as a "Bad Request" toast.
  const isProjectReady = Boolean(projectId);

  const canQuery = isProjectReady && enabled;

  // Fetch experiments
  const experimentsQuery = api.experiments.all.useQuery(getAllPayload, {
    enabled: canQuery,
    refetchOnWindowFocus: true,
    refetchInterval: RUN_POLL_INTERVAL_MS,
    // Keep polling while the tab is in the background: the table is often
    // watched from a second window, and a paused poll would freeze the item
    // counts while the spinner (pure CSS) keeps animating.
    refetchIntervalInBackground: true,
  });

  // Fetch total count
  const totalCountQuery = api.experiments.countAll.useQuery(getCountPayload, {
    enabled: canQuery,
    refetchOnWindowFocus: true,
    refetchInterval: RUN_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  // An empty time range hides runs that exist just outside it, which reads as
  // "there are no experiments". Fall back to the most recent runs instead — on
  // the first page only, so paging stays honest.
  const isEmptyWindow =
    totalCountQuery.data?.count === 0 && paginationState.page === 1;

  const mostRecentQuery = api.experiments.mostRecent.useQuery(
    { ...getCountPayload, limit: MOST_RECENT_FALLBACK_LIMIT },
    {
      enabled: canQuery && isEmptyWindow,
      refetchOnWindowFocus: false,
    },
  );

  const fallbackRows = isEmptyWindow ? mostRecentQuery.data?.data : undefined;
  const isShowingMostRecent = Boolean(fallbackRows?.length);

  // The rows the table renders: the filtered page, or the fallback when the
  // selected range holds nothing.
  const coreRows = isShowingMostRecent
    ? fallbackRows
    : experimentsQuery.data?.data;

  const totalCount = isShowingMostRecent
    ? (fallbackRows?.length ?? null)
    : (totalCountQuery.data?.count ?? null);

  // Build metrics payload based on the rows in view
  const metricsPayload = useMemo(() => {
    if (!coreRows || coreRows.length === 0) {
      return null;
    }

    return {
      projectId,
      experimentIds: coreRows.map((e) => e.id),
      filter: filterState,
    };
  }, [coreRows, projectId, filterState]);

  // Fetch metrics
  const metricsQuery = api.experiments.metrics.useQuery(metricsPayload!, {
    enabled: canQuery && metricsPayload !== null,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchInterval: RUN_POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  // Memoize joined data to prevent infinite re-renders
  // Handle loading, error, and success states
  const joinedData = useMemo(() => {
    // A disabled query is neither loading nor errored, so stay in the loading
    // state while the gate is shut instead of flashing "no rows".
    if (!canQuery || experimentsQuery.isLoading) {
      return { status: "loading" as const, rows: undefined };
    }

    if (experimentsQuery.isError) {
      return { status: "error" as const, rows: undefined };
    }

    // Don't render "no experiments" while the fallback is still in flight.
    if (isEmptyWindow && mostRecentQuery.isLoading) {
      return { status: "loading" as const, rows: undefined };
    }

    // Success case - join the data
    return joinTableCoreAndMetrics<ExperimentCoreData, ExperimentMetricsData>(
      coreRows,
      metricsQuery.data,
    );
  }, [
    canQuery,
    experimentsQuery.isLoading,
    experimentsQuery.isError,
    isEmptyWindow,
    mostRecentQuery.isLoading,
    coreRows,
    metricsQuery.data,
  ]);

  const dataUpdatedAt = experimentsQuery.dataUpdatedAt;

  // A run is "running" while its counts are still changing. Each poll is
  // compared against the previous snapshot; the grace window keeps the spinner
  // steady across the silent stretches between item completions.
  const runActivityRef = useRef<Map<string, RunActivitySnapshot>>(new Map());
  const [runningExperimentIds, setRunningExperimentIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!coreRows) return;

    const now = Date.now();
    const activity = runActivityRef.current;
    const inView = new Set<string>();

    for (const row of coreRows) {
      inView.add(row.id);
      const prev = activity.get(row.id);

      if (!prev) {
        // First sighting: judge by age. A run created moments ago is almost
        // certainly still inside its first model call and gets the spinner;
        // long-finished history does not.
        const startedAtMs = new Date(row.startTime).getTime();
        activity.set(row.id, {
          itemCount: row.itemCount,
          errorCount: row.errorCount,
          lastChangedAt: Math.max(startedAtMs, now - RUNNING_GRACE_MS),
        });
        continue;
      }

      if (
        prev.itemCount !== row.itemCount ||
        prev.errorCount !== row.errorCount
      ) {
        activity.set(row.id, {
          ...prev,
          itemCount: row.itemCount,
          errorCount: row.errorCount,
          lastChangedAt: now,
        });
      }
    }

    // Forget rows that left the current view (paging or filtering), so the
    // snapshot map cannot grow without bound.
    for (const id of activity.keys()) {
      if (!inView.has(id)) {
        activity.delete(id);
      }
    }

    const next = new Set<string>();
    for (const row of coreRows) {
      const snapshot = activity.get(row.id);
      if (snapshot && now - snapshot.lastChangedAt < RUNNING_GRACE_MS) {
        next.add(row.id);
      }
    }

    setRunningExperimentIds((prevSet) => {
      if (
        prevSet.size === next.size &&
        [...next].every((id) => prevSet.has(id))
      ) {
        return prevSet;
      }
      return next;
    });
  }, [coreRows]);

  return {
    experiments: joinedData,
    dataUpdatedAt,
    totalCount,
    metricsLoading: metricsQuery.isLoading,
    /** Row ids whose item/error count is still moving (run in progress). */
    runningExperimentIds,
    /** The rows shown are the most recent runs, not the selected time range. */
    isShowingMostRecent,
    /**
     * How many fallback runs are actually on screen. The cap is what was asked
     * for, not what came back, so a project with fewer runs than the cap must
     * not be told it is looking at ten of them.
     */
    mostRecentCount: fallbackRows?.length ?? 0,
  };
}
