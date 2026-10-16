// Disabled: cloud spend alerts not needed for internal deployment.
import { Processor } from "bullmq";
import { logger, QueueJobs } from "@langfuse/shared/src/server";

export const cloudSpendAlertQueueProcessor: Processor = async (job) => {
  if (job.name === QueueJobs.CloudSpendAlertJob) {
    logger.warn("CloudSpendAlertJob is disabled for internal deployment");
  }
};
