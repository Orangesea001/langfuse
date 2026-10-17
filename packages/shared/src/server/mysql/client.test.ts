/**
 * Unit tests for MySQL client (connection pool management).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let mockCreatePool: ReturnType<typeof vi.fn>;
let mockEnd: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockEnd = vi.fn().mockResolvedValue(undefined);
  mockCreatePool = vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue([[{ 1: 1 }], []]),
    end: mockEnd,
    getConnection: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue([[{ 1: 1 }], []]),
      release: vi.fn(),
    }),
  });
});

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: (...args: unknown[]) => {
      // Delegate to the mock set up in beforeEach
      return {
        query: vi.fn().mockResolvedValue([[{ 1: 1 }], []]),
        end: vi.fn().mockResolvedValue(undefined),
        getConnection: vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue([[{ 1: 1 }], []]),
          release: vi.fn(),
        }),
      };
    },
  },
}));

vi.mock("../../env", () => ({
  env: {
    LANGFUSE_MYSQL_URL: "mysql://root:test@localhost:3306/langfuse_test",
    LANGFUSE_MYSQL_CONNECTION_LIMIT: 5,
  },
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { getMySqlPool, closeMySqlPool } from "./client";

describe("MySQL client", () => {
  it("creates pool and returns it", () => {
    const pool = getMySqlPool();
    expect(pool).toBeDefined();
    expect(pool).toHaveProperty("query");
  });

  it("returns same pool on subsequent calls (singleton)", () => {
    const pool1 = getMySqlPool();
    const pool2 = getMySqlPool();
    expect(pool1).toBe(pool2);
  });

  it("closeMySqlPool resolves without error", async () => {
    await expect(closeMySqlPool()).resolves.not.toThrow();
  });
});
