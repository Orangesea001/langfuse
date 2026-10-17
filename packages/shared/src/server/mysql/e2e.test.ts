/**
 * End-to-end tests for MySQL analytics store.
 * Requires a running MySQL instance with LANGFUSE_MYSQL_URL set.
 * Run: LANGFUSE_MYSQL_URL=mysql://root:@localhost:3306/langfuse_test pnpm --filter @langfuse/shared exec vitest run src/server/mysql/e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql, { type RowDataPacket } from "mysql2/promise";

const MYSQL_URL =
  process.env.LANGFUSE_MYSQL_URL ||
  "mysql://root:@localhost:3306/langfuse_test";
const TEST_TABLE = "_e2e_test_traces";

let pool: mysql.Pool;

describe.skipIf(!process.env.LANGFUSE_MYSQL_URL)("MySQL E2E", () => {
  beforeAll(async () => {
    pool = mysql.createPool({
      uri: MYSQL_URL,
      waitForConnections: true,
      connectionLimit: 5,
    });
    // Create test table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (
        id VARCHAR(36) NOT NULL PRIMARY KEY,
        project_id VARCHAR(36) NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT '',
        timestamp DATETIME(3) NOT NULL,
        event_ts DATETIME(3) NOT NULL,
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        INDEX idx_project (project_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
      await pool.end();
    }
  });

  it("inserts and queries a row", async () => {
    const id = "e2e-test-1";
    const projectId = "proj-e2e";
    const now = new Date();

    await pool.query(
      `INSERT INTO ${TEST_TABLE} (id, project_id, name, timestamp, event_ts) VALUES (?, ?, ?, ?, ?)`,
      [id, projectId, "test-trace", now, now],
    );

    const [rows] = (await pool.query(
      `SELECT id, project_id, name FROM ${TEST_TABLE} WHERE id = ?`,
      [id],
    )) as [RowDataPacket[], unknown];

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      project_id: projectId,
      name: "test-trace",
    });
  });

  it("upserts with ON DUPLICATE KEY UPDATE", async () => {
    const id = "e2e-test-2";
    const now = new Date();

    // Insert
    await pool.query(
      `INSERT INTO ${TEST_TABLE} (id, project_id, name, timestamp, event_ts) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), timestamp = VALUES(timestamp), event_ts = VALUES(event_ts)`,
      [id, "proj-1", "original", now, now],
    );

    // Upsert (update)
    await pool.query(
      `INSERT INTO ${TEST_TABLE} (id, project_id, name, timestamp, event_ts) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), timestamp = VALUES(timestamp), event_ts = VALUES(event_ts)`,
      [id, "proj-1", "updated", now, now],
    );

    const [rows] = (await pool.query(
      `SELECT name FROM ${TEST_TABLE} WHERE id = ?`,
      [id],
    )) as [RowDataPacket[], unknown];
    expect(rows[0].name).toBe("updated");
  });

  it("handles CASE WHEN (replaces multiIf)", async () => {
    const id = "e2e-test-3";
    const now = new Date();

    await pool.query(
      `INSERT INTO ${TEST_TABLE} (id, project_id, name, timestamp, event_ts) VALUES (?, ?, ?, ?, ?)`,
      [id, "proj-1", "test", now, now],
    );

    // Test CASE WHEN expression
    const [rows] = (await pool.query(
      `SELECT CASE WHEN name = 'test' THEN 'YES' ELSE 'NO' END as result FROM ${TEST_TABLE} WHERE id = ?`,
      [id],
    )) as [RowDataPacket[], unknown];
    expect(rows[0].result).toBe("YES");
  });

  it("handles IFNULL (replaces ifNull)", async () => {
    const [rows] = (await pool.query(
      `SELECT IFNULL(NULL, 'default') as result`,
    )) as [RowDataPacket[], unknown];
    expect(rows[0].result).toBe("default");
  });

  it("handles NULLIF (replaces nullIf)", async () => {
    const [rows] = (await pool.query(
      `SELECT NULLIF('same', 'same') as result`,
    )) as [RowDataPacket[], unknown];
    expect(rows[0].result).toBeNull();
  });

  it("handles TIMESTAMPDIFF (replaces date_diff)", async () => {
    const [rows] = (await pool.query(
      `SELECT TIMESTAMPDIFF(SECOND, '2024-01-01 00:00:00', '2024-01-01 00:00:30') as diff`,
    )) as [RowDataPacket[], unknown];
    expect(Number(rows[0].diff)).toBe(30);
  });

  it("handles CHAR_LENGTH (replaces lengthUTF8)", async () => {
    const [rows] = (await pool.query(`SELECT CHAR_LENGTH('hello') as len`)) as [
      RowDataPacket[],
      unknown,
    ];
    expect(Number(rows[0].len)).toBe(5);
  });

  it("handles JSON functions (for CH array/map replacement)", async () => {
    // JSON_CONTAINS
    const [r1] = (await pool.query(
      `SELECT JSON_CONTAINS('["a","b"]', '"a"') as result`,
    )) as [RowDataPacket[], unknown];
    expect(Number(r1[0].result)).toBe(1);

    // JSON_LENGTH
    const [r2] = (await pool.query(
      `SELECT JSON_LENGTH('["a","b","c"]') as len`,
    )) as [RowDataPacket[], unknown];
    expect(Number(r2[0].len)).toBe(3);

    // JSON_EXTRACT
    const [r3] = (await pool.query(
      `SELECT JSON_EXTRACT('["x","y"]', '$[0]') as val`,
    )) as [RowDataPacket[], unknown];
    expect(r3[0].val).toBe("x"); // mysql2 auto-parses JSON scalars
  });
});
