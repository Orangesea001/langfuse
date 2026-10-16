// Disabled: cloud free tier usage thresholds not needed for internal deployment.
import { Processor } from "bullmq";
import { logger, QueueJobs } from "@langfuse/shared/src/server";

export const cloudFreeTierUsageThresholdQueueProcessor: Processor = async (job) => {
  if (job.name === QueueJobs.CloudFreeTierUsageThresholdJob) {
    logger.warn("CloudFreeTierUsageThresholdJob is disabled for internal deployment");
  }
};
