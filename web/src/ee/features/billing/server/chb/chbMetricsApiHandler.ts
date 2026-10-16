// Disabled: CHB metrics API handler not needed for internal deployment.
// This handler used ClickHouse aggregation queries for cloud billing.

import { logger } from "@langfuse/shared/src/server";

export const chbMetricsApiHandler = async () => {
  logger.warn("CHB metrics API is disabled for internal deployment");
  throw new Error("CHB metrics API has been disabled for internal deployment.");
};
