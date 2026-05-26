import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, gte, lt } from "drizzle-orm";
import { createDb, type AnyDb, pipelineRuns, pmApprovals } from "../db/index.js";
import { loadMigrationFiles, runMigrationsSqlite, getMigrationStatusSqlite } from "../db/migrator.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-migration-test-${id}.sqlite`;
}

describe("database migrations", () => {
  const paths: string[] = [];

  async function makeDb(): Promise<AnyDb> {
    const path = tmpDbPath();
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      try {
        unlinkSync(p);
        unlinkSync(p + "-wal");
        unlinkSync(p + "-shm");
      } catch {
        // ignore
      }
    }
    paths.length = 0;
  });

  it("loads migration files in alphabetical order", () => {
    const migrations = loadMigrationFiles("sqlite");
    expect(migrations.length).toBeGreaterThan(0);

    // Verify migrations are sorted by name
    const names = migrations.map(m => m.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("includes the new missing_indexes migration", () => {
    const migrations = loadMigrationFiles("sqlite");
    const migrationNames = migrations.map(m => m.name);
    // BEC-149: missing_indexes was renumbered from 013 to 014 to fix a
    // prefix collision with 013_triage_results.
    expect(migrationNames).toContain("014_missing_indexes");
  });

  it("migration file contains CREATE INDEX IF NOT EXISTS statements", () => {
    const migrations = loadMigrationFiles("sqlite");
    const missingIndexesMigration = migrations.find(m => m.name === "014_missing_indexes");

    expect(missingIndexesMigration).toBeDefined();
    expect(missingIndexesMigration!.sql).toContain("CREATE INDEX IF NOT EXISTS");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_pr_url");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_branch");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_started_at");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_completed_at");
    expect(missingIndexesMigration!.sql).toContain("idx_pm_approvals_issue_id");
  });

  it("runs all migrations successfully during db initialization", async () => {
    const db = await makeDb();
    expect(db).toBeDefined();
  });

  it("migrations are idempotent (can be run multiple times safely)", async () => {
    const path = tmpDbPath();
    paths.push(path);

    // Import sqlite for raw access
    const Database = (await import("better-sqlite3")).default;
    const sqliteDb = new Database(path);

    try {
      // Run migrations first time
      runMigrationsSqlite(sqliteDb);

      // Get status after first run
      const statusAfterFirstRun = getMigrationStatusSqlite(sqliteDb);
      const appliedCountFirstRun = statusAfterFirstRun.filter(s => s.applied).length;
      expect(appliedCountFirstRun).toBeGreaterThan(0);

      // Run migrations again (should be idempotent)
      runMigrationsSqlite(sqliteDb);

      // Get status after second run
      const statusAfterSecondRun = getMigrationStatusSqlite(sqliteDb);
      const appliedCountSecondRun = statusAfterSecondRun.filter(s => s.applied).length;

      // Should have same number of applied migrations
      expect(appliedCountSecondRun).toBe(appliedCountFirstRun);

      // All migrations should be marked as applied
      const allApplied = statusAfterSecondRun.every(s => s.applied);
      expect(allApplied).toBe(true);
    } finally {
      sqliteDb.close();
    }
  });

  it("can query pipeline_runs by pr_url (indexed column)", async () => {
    const db = await makeDb();
    const now = new Date();

    // Insert test data
    await db.insert(pipelineRuns).values({
      id: "pr-index-test-1",
      issueId: "ISSUE-1",
      issueTitle: "Test PR URL indexing",
      pipelineKey: "default",
      repoUrl: "https://github.com/org/repo",
      prUrl: "https://github.com/org/repo/pull/123",
      status: "completed",
      startedAt: now,
      completedAt: now,
    });

    // Query by pr_url
    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.prUrl, "https://github.com/org/repo/pull/123"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("pr-index-test-1");
  });

  it("can query pipeline_runs by branch (indexed column)", async () => {
    const db = await makeDb();
    const now = new Date();

    await db.insert(pipelineRuns).values({
      id: "pr-branch-test-1",
      issueId: "ISSUE-2",
      issueTitle: "Test branch indexing",
      pipelineKey: "default",
      repoUrl: "https://github.com/org/repo",
      branch: "agent/issue-2-fix-bug",
      status: "completed",
      startedAt: now,
      completedAt: now,
    });

    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.branch, "agent/issue-2-fix-bug"));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("pr-branch-test-1");
  });

  it("can range query pipeline_runs by started_at (indexed column)", async () => {
    const db = await makeDb();
    const baseTime = new Date("2026-05-11T10:00:00Z");
    const later = new Date("2026-05-11T11:00:00Z");

    await db.insert(pipelineRuns).values([
      {
        id: "pr-time-test-1",
        issueId: "ISSUE-3",
        issueTitle: "Early run",
        pipelineKey: "default",
        repoUrl: "https://github.com/org/repo",
        status: "completed",
        startedAt: baseTime,
        completedAt: baseTime,
      },
      {
        id: "pr-time-test-2",
        issueId: "ISSUE-4",
        issueTitle: "Late run",
        pipelineKey: "default",
        repoUrl: "https://github.com/org/repo",
        status: "completed",
        startedAt: later,
        completedAt: later,
      },
    ]);

    // Range query on started_at
    const rows = await db.select().from(pipelineRuns).where(
      lt(pipelineRuns.startedAt, later)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("pr-time-test-1");
  });

  it("can range query pipeline_runs by completed_at (indexed column)", async () => {
    const db = await makeDb();
    const baseTime = new Date("2026-05-11T10:00:00Z");
    const midTime = new Date("2026-05-11T11:00:00Z");

    await db.insert(pipelineRuns).values([
      {
        id: "pr-complete-test-1",
        issueId: "ISSUE-5",
        issueTitle: "Completed early",
        pipelineKey: "default",
        repoUrl: "https://github.com/org/repo",
        status: "completed",
        startedAt: baseTime,
        completedAt: baseTime,
      },
      {
        id: "pr-complete-test-2",
        issueId: "ISSUE-6",
        issueTitle: "Still running",
        pipelineKey: "default",
        repoUrl: "https://github.com/org/repo",
        status: "running",
        startedAt: baseTime,
        completedAt: null,
      },
    ]);

    // Range query on completed_at
    const rows = await db.select().from(pipelineRuns).where(
      gte(pipelineRuns.completedAt, baseTime)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("pr-complete-test-1");
  });

  it("can query pm_approvals by issue_id (indexed column)", async () => {
    const db = await makeDb();
    const now = new Date();

    await db.insert(pmApprovals).values([
      {
        id: "approval-1",
        issueId: "ISSUE-100",
        action: "deprioritize",
        reason: "Need more context",
        slackMessageTs: "ts-1",
        status: "pending",
        createdAt: now,
      },
      {
        id: "approval-2",
        issueId: "ISSUE-100",
        action: "cancel",
        reason: "User cancelled",
        slackMessageTs: "ts-2",
        status: "resolved",
        createdAt: now,
        resolvedAt: now,
      },
      {
        id: "approval-3",
        issueId: "ISSUE-101",
        action: "deprioritize",
        reason: "Different issue",
        slackMessageTs: "ts-3",
        status: "pending",
        createdAt: now,
      },
    ]);

    // Query by issue_id
    const rows = await db.select().from(pmApprovals).where(eq(pmApprovals.issueId, "ISSUE-100"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { issueId: string }) => r.issueId === "ISSUE-100")).toBe(true);
  });

  it("postgres migration file also includes all 5 indexes", async () => {
    const pgMigrations = loadMigrationFiles("postgres");
    // BEC-149: missing_indexes was renumbered from 014 to 015 in Postgres to
    // fix a prefix collision with 014_stage_runs_cache_tokens.
    const missingIndexesMigration = pgMigrations.find(m => m.name === "015_missing_indexes");

    expect(missingIndexesMigration).toBeDefined();
    expect(missingIndexesMigration!.sql).toContain("CREATE INDEX IF NOT EXISTS");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_pr_url");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_branch");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_started_at");
    expect(missingIndexesMigration!.sql).toContain("idx_pipeline_runs_completed_at");
    expect(missingIndexesMigration!.sql).toContain("idx_pm_approvals_issue_id");
  });
});
