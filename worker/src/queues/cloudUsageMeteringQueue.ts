// Disabled: cloud usage metering not needed for internal deployment.
import { Processor } from "bullmq";
import { logger, QueueJobs } from "@langfuse/shared/src/server";

export const cloudUsageMeteringQueueProcessor: Processor = async (job) => {
  if (job.name === QueueJobs.CloudUsageMeteringJob) {
    logger.warn("CloudUsageMeteringJob is disabled for internal deployment");
  }
};
