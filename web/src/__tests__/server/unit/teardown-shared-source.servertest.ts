import { expect, it, vi } from "vitest";
import { env } from "@langfuse/shared/src/env";
import { analyticsClient } from "@langfuse/shared/src/server";
import teardown from "../../teardown";

it("closes clients through the same source-module identity", async () => {
  const client = analyticsClient();
  const close = vi.spyOn(client, "end");

  try {
    await teardown();

    expect(close).toHaveBeenCalledOnce();
  } finally {
    close.mockRestore();
  }
});
