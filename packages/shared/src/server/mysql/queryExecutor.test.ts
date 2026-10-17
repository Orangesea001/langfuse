/**
 * Unit tests for MySQL query executor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQuery = vi.fn();
const mockSpan = { setAttribute: vi.fn() };

vi.mock("./client", () => ({
  getMySqlPool: () => ({ query: mockQuery }),
  closeMySqlPool: vi.fn(),
}));

vi.mock("../instrumentation", () => ({
  getTracer: () => ({}),
  instrumentAsync: (_opts: unknown, fn: (span: unknown) => Promise<unknown>) =>
    fn(mockSpan),
}));

vi.mock("../../env", () => ({
  env: {
    LANGFUSE_MYSQL_URL: "mysql://test:test@localhost:3306/langfuse_test",
    LANGFUSE_MYSQL_CONNECTION_LIMIT: 10,
  },
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  queryMySql,
  queryMySqlScalar,
  executeMySql,
  commandMySql,
} from "./queryExecutor";

describe("queryMySql", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSpan.setAttribute.mockReset();
  });

  it("translates named params to positional", async () => {
    mockQuery.mockResolvedValue([[{ id: "t1", cnt: 5 }], []]);
    const r = await queryMySql<{ id: string; cnt: number }>({
      query:
        "SELECT id, count() as cnt FROM traces WHERE project_id = {projectId: String}",
      params: { projectId: "p1" },
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("project_id = ?");
    expect(params).toEqual(["p1"]);
    expect(r).toEqual([{ id: "t1", cnt: 5 }]);
  });

  it("handles queries without params", async () => {
    mockQuery.mockResolvedValue([[{ cnt: 42 }], []]);
    const r = await queryMySql<{ cnt: number }>({
      query: "SELECT count() as cnt FROM traces",
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toBe("SELECT count() as cnt FROM traces");
    expect(params).toEqual([]);
    expect(r).toEqual([{ cnt: 42 }]);
  });

  it("sets db.system on span", async () => {
    mockQuery.mockResolvedValue([[{ id: "1" }], []]);
    await queryMySql<{ id: string }>({ query: "SELECT id FROM traces" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("db.system", "mysql");
  });

  it("returns empty array for no results", async () => {
    mockQuery.mockResolvedValue([[], []]);
    const r = await queryMySql<{ id: string }>({
      query: "SELECT id FROM traces WHERE id = {id: String}",
      params: { id: "x" },
    });
    expect(r).toEqual([]);
  });
});

describe("queryMySqlScalar", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("returns first column of first row", async () => {
    mockQuery.mockResolvedValue([[{ cnt: 42 }], []]);
    const r = await queryMySqlScalar<number>({
      query: "SELECT count() as cnt FROM traces",
    });
    expect(r).toBe(42);
  });

  it("returns undefined for empty result", async () => {
    mockQuery.mockResolvedValue([[], []]);
    const r = await queryMySqlScalar<number>({
      query: "SELECT count() as cnt FROM traces WHERE 1=0",
    });
    expect(r).toBeUndefined();
  });
});

describe("executeMySql", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("executes with positional params", async () => {
    const res = { affectedRows: 1, insertId: 0 };
    mockQuery.mockResolvedValue([res, []]);
    const r = await executeMySql("INSERT INTO t (a,b) VALUES (?,?)", [
      "x",
      "y",
    ]);
    expect(mockQuery).toHaveBeenCalledWith("INSERT INTO t (a,b) VALUES (?,?)", [
      "x",
      "y",
    ]);
    expect(r).toEqual(res);
  });
});

describe("commandMySql", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("executes DDL", async () => {
    mockQuery.mockResolvedValue([{}, []]);
    await commandMySql(
      "CREATE TABLE IF NOT EXISTS t (id VARCHAR(36) PRIMARY KEY)",
    );
    expect(mockQuery).toHaveBeenCalledWith(
      "CREATE TABLE IF NOT EXISTS t (id VARCHAR(36) PRIMARY KEY)",
      undefined,
    );
  });
});
