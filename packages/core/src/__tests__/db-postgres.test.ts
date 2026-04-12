/**
 * Postgres Integration Tests — BEC-115
 *
 * These tests verify that the unified schema (crossTimestamp), DDL generation,
 * migration helpers, and SQL utilities work correctly against a real Postgres
 * instance.
 *
 * Set TEST_POSTGRES_URL to run these tests:
 *   TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/testdb npx vitest run src/__tests__/db-postgres.test.ts
 *
 * The suite is skipped automatically when TEST_POSTGRES_URL is not configured.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  pipelineRuns,
  stageRuns,
  agentLogs,
  sqlDateGroup,
  sqlDaysAgoFilter,
  getCreateTablesDDL,
  getMigratePostgres,
  type Db,
} from "../db/index.js";

const TEST_URL = process.env.TEST_POSTGRES_URL;

describe.skipIf(!TEST_URL)("Postgres integration (BEC-115)", () => {
  let db: Db;
  // Raw postgres-js client for verification queries that bypass Drizzle's type layer.
  let pgClient: ReturnType<typeof postgres>;

  // Unique prefix per test run to avoid cross-run conflicts.
  const runPrefix = `bec115-${Date.now()}`;
  let counter = 0;

  // ID factories — track everything so afterAll can clean up in FK order.
  const insertedLogIds: string[] = [];
  const insertedSrIds: string[] = [];
  const insertedPrIds: string[] = [];

  function logId(): string {
    const id = `${runPrefix}-log-${counter++}`;
    insertedLogIds.push(id);
    return id;
  }
  function srId(): string {
    const id = `${runPrefix}-sr-${counter++}`;
    insertedSrIds.push(id);
    return id;
  }
  function prId(): string {
    const id = `${runPrefix}-pr-${counter++}`;
    insertedPrIds.push(id);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Setup / Teardown
  // ---------------------------------------------------------------------------

  beforeAll(async () => {
    // Raw client for information_schema queries and verification.
    pgClient = postgres(TEST_URL!);
    // createDb() internally runs getCreateTablesDDL + getMigratePostgres + file migrations.
    db = await createDb({ connectionString: TEST_URL! });
  });

  afterAll(async () => {
    // Delete test rows in FK order: agent_logs → stage_runs → pipeline_runs.
    if (db) {
      const anyDb = db as any;
      if (insertedLogIds.length > 0) {
        await anyDb.delete(agentLogs).where(inArray(agentLogs.id, insertedLogIds));
      }
      if (insertedSrIds.length > 0) {
        await anyDb.delete(stageRuns).where(inArray(stageRuns.id, insertedSrIds));
      }
      if (insertedPrIds.length > 0) {
        await anyDb.delete(pipelineRuns).where(inArray(pipelineRuns.id, insertedPrIds));
      }
    }
    if (pgClient) {
      await pgClient.end();
    }
  });

  // ---------------------------------------------------------------------------
  // 1. createDb() establishes a Postgres connection
  // ---------------------------------------------------------------------------

  it("createDb() establishes a Postgres connection and returns a Db instance", async () => {
    expect(db).toBeDefined();
    // Confirm the connection is live by executing a trivial query via raw client.
    const result = await pgClient`SELECT 1 AS ping`;
    expect(result).toHaveLength(1);
    expect(result[0].ping).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 2. getCreateTablesDDL("postgres") — all tables are created
  // ---------------------------------------------------------------------------

  it("getCreateTablesDDL('postgres') generates TIMESTAMPTZ DDL and all expected tables exist", async () => {
    const ddl = getCreateTablesDDL("postgres");

    // Structural assertions on the generated DDL string.
    expect(ddl).toContain("TIMESTAMPTZ");
    expect(ddl).toContain("now()");
    expect(ddl).not.toContain("unixepoch");
    expect(ddl).toContain("pipeline_runs");
    expect(ddl).toContain("stage_runs");
    expect(ddl).toContain("agent_logs");
    expect(ddl).toContain("pm_approvals");
    expect(ddl).toContain("active_work");
    expect(ddl).toContain("webhook_dedup");
    expect(ddl).toContain("BOOLEAN"); // auto_merged, auto_committed

    // Run the DDL against the real Postgres instance (IF NOT EXISTS = idempotent).
    await pgClient.unsafe(ddl);

    // Verify all expected tables exist in the public schema.
    const rows = await pgClient`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'pipeline_runs', 'stage_runs', 'agent_logs',
          'pm_approvals', 'active_work', 'webhook_dedup'
        )
      ORDER BY table_name
    `;
    const names = rows.map((r: any) => r.table_name);
    expect(names).toContain("pipeline_runs");
    expect(names).toContain("stage_runs");
    expect(names).toContain("agent_logs");
    expect(names).toContain("pm_approvals");
    expect(names).toContain("active_work");
    expect(names).toContain("webhook_dedup");
    expect(names).toHaveLength(6);
  });

  // ---------------------------------------------------------------------------
  // 3. getMigratePostgres() — migration columns are added
  // ---------------------------------------------------------------------------

  it("getMigratePostgres() generates a valid DO block and all migration columns exist", async () => {
    const migrationSql = getMigratePostgres();

    // Structural assertions on the generated migration block.
    expect(migrationSql).toContain("DO $$");
    expect(migrationSql).toContain("END $$;");
    expect(migrationSql).toContain("information_schema.columns");
    expect(migrationSql).toContain("IF NOT EXISTS");

    // Execute the migration block against Postgres (idempotent due to IF NOT EXISTS guards).
    await pgClient.unsafe(migrationSql);

    // Verify each migration column is present in information_schema.
    const expectedColumns: Array<{ table: string; column: string }> = [
      { table: "pipeline_runs", column: "retry_count" },
      { table: "pipeline_runs", column: "run_type" },
      { table: "pipeline_runs", column: "parent_run_id" },
      { table: "pipeline_runs", column: "feedback_context" },
      { table: "pipeline_runs", column: "auto_merged" },
      { table: "pipeline_runs", column: "auto_merge_reason" },
      { table: "pipeline_runs", column: "auto_committed" },
    ];

    for (const { table, column } of expectedColumns) {
      const result = await pgClient`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name  = ${table}
          AND column_name = ${column}
      `;
      expect(
        result,
        `Expected column ${table}.${column} to exist after getMigratePostgres()`,
      ).toHaveLength(1);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. crossTimestamp round-trip via toDriver / fromDriver
  // ---------------------------------------------------------------------------

  it("crossTimestamp round-trips Date values correctly through Postgres TIMESTAMPTZ", async () => {
    const anyDb = db as any;

    // Truncate to second precision (minimum shared precision after round-trip).
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const hourAgo = new Date(now.getTime() - 3_600_000);

    const pr = prId();
    const sr = srId();
    const lg = logId();

    // Insert via Drizzle ORM — crossTimestamp.toDriver() converts Date → ISO string.
    await anyDb.insert(pipelineRuns).values({
      id: pr,
      issueId: "PG-TS-ROUNDTRIP",
      issueTitle: "Timestamp round-trip",
      pipelineKey: "default",
      repoUrl: "https://github.com/test/repo",
      status: "running",
      startedAt: now,
    });

    await anyDb.insert(stageRuns).values({
      id: sr,
      pipelineRunId: pr,
      stage: "implement",
      status: "completed",
      startedAt: hourAgo,
      completedAt: now,
    });

    await anyDb.insert(agentLogs).values({
      id: lg,
      stageRunId: sr,
      timestamp: hourAgo,
      type: "message",
      content: "Postgres round-trip test",
    });

    // Read back via the raw postgres-js client — Postgres returns TIMESTAMPTZ as
    // JS Date objects, so crossTimestamp.fromDriver() returns them as-is.
    const prRow = await pgClient`SELECT started_at FROM pipeline_runs WHERE id = ${pr}`;
    expect(prRow).toHaveLength(1);
    expect(prRow[0].started_at).toBeInstanceOf(Date);
    expect(prRow[0].started_at.getTime()).toBe(now.getTime());

    const srRow = await pgClient`SELECT started_at, completed_at FROM stage_runs WHERE id = ${sr}`;
    expect(srRow).toHaveLength(1);
    expect(srRow[0].started_at).toBeInstanceOf(Date);
    expect(srRow[0].started_at.getTime()).toBe(hourAgo.getTime());
    expect(srRow[0].completed_at).toBeInstanceOf(Date);
    expect(srRow[0].completed_at.getTime()).toBe(now.getTime());

    const lgRow = await pgClient`SELECT timestamp FROM agent_logs WHERE id = ${lg}`;
    expect(lgRow).toHaveLength(1);
    expect(lgRow[0].timestamp).toBeInstanceOf(Date);
    expect(lgRow[0].timestamp.getTime()).toBe(hourAgo.getTime());
  });

  // ---------------------------------------------------------------------------
  // 5. sqlDateGroup() — correct YYYY-MM-DD grouping on Postgres
  // ---------------------------------------------------------------------------

  it("sqlDateGroup() produces correct YYYY-MM-DD date grouping when executed on Postgres", async () => {
    const anyDb = db as any;

    // Create two logs a few minutes apart — both on the same calendar day.
    const base = new Date();
    base.setHours(0, 0, 0, 0); // midnight today (local)
    const t1 = new Date(base.getTime() + 1_000); // 1 s after midnight
    const t2 = new Date(base.getTime() + 3_600_000); // 1 h after midnight

    const pr = prId();
    const sr1 = srId();
    const sr2 = srId();
    const lg1 = logId();
    const lg2 = logId();

    await anyDb.insert(pipelineRuns).values({
      id: pr,
      issueId: "PG-DATEGROUP",
      issueTitle: "sqlDateGroup test",
      pipelineKey: "default",
      repoUrl: "https://github.com/test/repo",
      status: "running",
      startedAt: t1,
    });

    await anyDb.insert(stageRuns).values([
      { id: sr1, pipelineRunId: pr, stage: "triage", status: "completed", startedAt: t1 },
      { id: sr2, pipelineRunId: pr, stage: "implement", status: "completed", startedAt: t2 },
    ]);

    await anyDb.insert(agentLogs).values([
      { id: lg1, stageRunId: sr1, timestamp: t1, type: "msg", content: "first" },
      { id: lg2, stageRunId: sr2, timestamp: t2, type: "msg", content: "second" },
    ]);

    // Both logs share the same calendar day — grouping should yield exactly one bucket.
    const result = await anyDb
      .select({ dateGroup: sqlDateGroup(db, agentLogs.timestamp) })
      .from(agentLogs)
      .where(inArray(agentLogs.id, [lg1, lg2]))
      .groupBy(sqlDateGroup(db, agentLogs.timestamp));

    expect(result).toHaveLength(1);
    // Postgres to_char output: 'YYYY-MM-DD'
    expect(result[0].dateGroup).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The date bucket should match today's UTC date (Postgres TIMESTAMPTZ → UTC).
    const expectedDate = t1.toISOString().slice(0, 10);
    expect(result[0].dateGroup).toBe(expectedDate);
  });

  // ---------------------------------------------------------------------------
  // 6. sqlDaysAgoFilter() — correct filtering on Postgres
  // ---------------------------------------------------------------------------

  it("sqlDaysAgoFilter() correctly filters recent rows and excludes old rows on Postgres", async () => {
    const anyDb = db as any;

    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3_600_000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 3_600_000);

    const pr = prId();
    const srRecent = srId();
    const srOld = srId();
    const lgRecent = logId();
    const lgOld = logId();

    await anyDb.insert(pipelineRuns).values({
      id: pr,
      issueId: "PG-DAYSAGO",
      issueTitle: "sqlDaysAgoFilter test",
      pipelineKey: "default",
      repoUrl: "https://github.com/test/repo",
      status: "running",
      startedAt: twoDaysAgo,
    });

    await anyDb.insert(stageRuns).values([
      { id: srRecent, pipelineRunId: pr, stage: "triage", status: "completed", startedAt: twoDaysAgo },
      { id: srOld, pipelineRunId: pr, stage: "implement", status: "completed", startedAt: thirtyDaysAgo },
    ]);

    await anyDb.insert(agentLogs).values([
      { id: lgRecent, stageRunId: srRecent, timestamp: twoDaysAgo, type: "msg", content: "recent" },
      { id: lgOld, stageRunId: srOld, timestamp: thirtyDaysAgo, type: "msg", content: "old" },
    ]);

    // Filter for last 7 days: lgRecent (2 days ago) passes; lgOld (30 days ago) is excluded.
    const result = await anyDb
      .select({ id: agentLogs.id })
      .from(agentLogs)
      .where(
        and(
          inArray(agentLogs.id, [lgRecent, lgOld]),
          sqlDaysAgoFilter(db, agentLogs.timestamp, 7),
        ),
      );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(lgRecent);
  });
});
