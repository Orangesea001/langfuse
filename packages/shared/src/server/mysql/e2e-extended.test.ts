/**
 * Extended end-to-end tests for MySQL analytics store.
 * Requires a running MySQL instance with LANGFUSE_MYSQL_URL set
 * and the json_map_sum_like, json_median UDFs created.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql, { type RowDataPacket } from "mysql2/promise";

const MYSQL_URL =
  process.env.LANGFUSE_MYSQL_URL ||
  "mysql://root:@localhost:3306/langfuse_test";

let pool: mysql.Pool;

describe.skipIf(!process.env.LANGFUSE_MYSQL_URL)("MySQL E2E Extended", () => {
  beforeAll(async () => {
    pool = mysql.createPool({
      uri: MYSQL_URL,
      waitForConnections: true,
      connectionLimit: 5,
    });
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        "DROP TABLE IF EXISTS _e2e_scores, _e2e_observations, _e2e_traces",
      );
      await pool.end();
    }
  });

  it("json_map_sum_like UDF sums values by key pattern", async () => {
    // Test input usage extraction
    const [r1] = (await pool.query(
      `SELECT json_map_sum_like('{"input_tokens": 100, "prompt_tokens": 50, "output_tokens": 30, "total": 180}', '%input%') as result`,
    )) as [RowDataPacket[], unknown];
    expect(Number(r1[0].result)).toBe(100);

    // Test output usage extraction
    const [r2] = (await pool.query(
      `SELECT json_map_sum_like('{"input_tokens": 100, "prompt_tokens": 50, "output_tokens": 30, "total": 180}', '%output%') as result`,
    )) as [RowDataPacket[], unknown];
    expect(Number(r2[0].result)).toBe(30);
  });

  it("json_median UDF returns value as-is", async () => {
    const [rows] = (await pool.query(`SELECT json_median(42.0) as result`)) as [
      RowDataPacket[],
      unknown,
    ];
    expect(Number(rows[0].result)).toBe(42);
  });
});
