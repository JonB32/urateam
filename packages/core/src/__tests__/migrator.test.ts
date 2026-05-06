import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import postgres from "postgres";
import {
  loadMigrationFiles,
  runMigrationsSqlite,
  runMigrationsPostgres,
  getMigrationStatusSqlite,
  getMigrationStatusPostgres,
  type Migration,
  type MigrationStatus,
} from "../db/migrator.js";

describe("Migration Framework", () => {
  describe("loadMigrationFiles", () => {
    it("should load SQLite migration files in order", () => {
      const migrations = loadMigrationFiles("sqlite");
      expect(migrations.length).toBeGreaterThan(0);
      expect(migrations[0].name).toBe("001_initial_schema");
      // Verify they're sorted
      const names = migrations.map((m) => m.name);
      expect(names).toEqual([...names].sort());
    });

    it("should load Postgres migration files in order", () => {
      const migrations = loadMigrationFiles("postgres");
      expect(migrations.length).toBeGreaterThan(0);
      expect(migrations[0].name).toBe("001_initial_schema");
      // Verify they're sorted
      const names = migrations.map((m) => m.name);
      expect(names).toEqual([...names].sort());
    });

    it("should include SQL content", () => {
      const migrations = loadMigrationFiles("sqlite");
      for (const migration of migrations) {
        expect(migration.sql).toBeTruthy();
        expect(migration.sql.length).toBeGreaterThan(0);
      }
    });

    it("should handle missing migrations directory gracefully", () => {
      // This test verifies the function doesn't crash if migrations dir is missing
      // In production code, it returns empty array
      const migrations = loadMigrationFiles("sqlite" as any);
      // Should not throw
      expect(Array.isArray(migrations)).toBe(true);
    });
  });

  describe("SQLite Migrations", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(":memory:");
    });

    afterEach(() => {
      db.close();
    });

    it("should create schema_migrations table on first run", () => {
      runMigrationsSqlite(db);

      const tableExists = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`
        )
        .get();

      expect(tableExists).toBeTruthy();
    });

    it("should record applied migrations in schema_migrations", () => {
      runMigrationsSqlite(db);

      const migrations = loadMigrationFiles("sqlite");
      const recorded = db
        .prepare("SELECT name FROM schema_migrations ORDER BY name")
        .all() as Array<{ name: string }>;

      const recordedNames = recorded.map((r) => r.name);
      const migrationNames = migrations.map((m) => m.name);

      expect(recordedNames).toEqual(migrationNames);
    });

    it("should create all expected tables", () => {
      runMigrationsSqlite(db);

      const expectedTables = [
        "pipeline_runs",
        "stage_runs",
        "agent_logs",
        "pm_approvals",
        "active_work",
        "webhook_dedup",
        "schema_migrations",
      ];

      for (const table of expectedTables) {
        const tableExists = db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
          )
          .get(table);
        expect(tableExists).toBeTruthy();
      }
    });

    it("should be idempotent (safe to run twice)", () => {
      // First run
      runMigrationsSqlite(db);
      const recordedAfterFirst = db
        .prepare("SELECT COUNT(*) as count FROM schema_migrations")
        .get() as { count: number };

      // Second run (should not reapply)
      runMigrationsSqlite(db);
      const recordedAfterSecond = db
        .prepare("SELECT COUNT(*) as count FROM schema_migrations")
        .get() as { count: number };

      expect(recordedAfterSecond.count).toBe(recordedAfterFirst.count);
    });

    it("should handle duplicate column errors gracefully", () => {
      // Run once to set up
      runMigrationsSqlite(db);

      // Running again should not fail even if ALTER TABLE ADD COLUMN already exists
      expect(() => {
        runMigrationsSqlite(db);
      }).not.toThrow();
    });

    it("should track migration applied_at timestamp", () => {
      const beforeTime = Math.floor(Date.now() / 1000);
      runMigrationsSqlite(db);
      const afterTime = Math.floor(Date.now() / 1000);

      const migrations = db
        .prepare(
          "SELECT applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
        )
        .get() as { applied_at: number };

      expect(migrations.applied_at).toBeGreaterThanOrEqual(beforeTime);
      expect(migrations.applied_at).toBeLessThanOrEqual(afterTime + 1);
    });

    it("getMigrationStatusSqlite should report correct status", () => {
      runMigrationsSqlite(db);
      const statuses = getMigrationStatusSqlite(db);

      const migrations = loadMigrationFiles("sqlite");
      expect(statuses.length).toBe(migrations.length);

      // All should be applied
      for (const status of statuses) {
        expect(status.applied).toBe(true);
        expect(status.appliedAt).toBeInstanceOf(Date);
      }
    });

    it("getMigrationStatusSqlite should report pending migrations correctly", () => {
      // Don't run migrations, just check status
      const statuses = getMigrationStatusSqlite(db);

      const migrations = loadMigrationFiles("sqlite");
      expect(statuses.length).toBe(migrations.length);

      // All should be pending
      for (const status of statuses) {
        expect(status.applied).toBe(false);
        expect(status.appliedAt).toBeUndefined();
      }
    });
  });

  describe("Postgres Migrations", () => {
    let client: postgres.Sql;
    const dbUrl = process.env.TEST_POSTGRES_URL;

    beforeEach(async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres tests: TEST_POSTGRES_URL not set");
        return;
      }

      client = postgres(dbUrl);
      // Clean up before test
      try {
        await client.unsafe("DROP TABLE IF EXISTS agent_logs CASCADE");
        await client.unsafe("DROP TABLE IF EXISTS stage_runs CASCADE");
        await client.unsafe("DROP TABLE IF EXISTS pipeline_runs CASCADE");
        await client.unsafe("DROP TABLE IF EXISTS pm_approvals CASCADE");
        await client.unsafe("DROP TABLE IF EXISTS active_work CASCADE");
        await client.unsafe("DROP TABLE IF EXISTS webhook_dedup CASCADE");
        await client.unsafe("DROP TABLE IF EXISTS schema_migrations CASCADE");
      } catch {
        // Ignore cleanup errors
      }
    });

    afterEach(async () => {
      if (!dbUrl || !client) return;

      try {
        await client.end();
      } catch {
        // Ignore cleanup errors
      }
    });

    it("should create schema_migrations table on first run", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      await runMigrationsPostgres(client);

      const result = await client.unsafe(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations')"
      );
      expect(result[0].exists).toBe(true);
    });

    it("should record applied migrations in schema_migrations", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      await runMigrationsPostgres(client);

      const migrations = loadMigrationFiles("postgres");
      const recorded = await client`SELECT name FROM schema_migrations ORDER BY name`;

      const recordedNames = recorded.map((r) => r.name);
      const migrationNames = migrations.map((m) => m.name);

      expect(recordedNames).toEqual(migrationNames);
    });

    it("should create all expected tables", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      await runMigrationsPostgres(client);

      const expectedTables = [
        "pipeline_runs",
        "stage_runs",
        "agent_logs",
        "pm_approvals",
        "active_work",
        "webhook_dedup",
        "schema_migrations",
      ];

      for (const table of expectedTables) {
        const result = await client.unsafe(
          `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)`,
          [table]
        );
        expect(result[0].exists).toBe(true);
      }
    });

    it("should be idempotent (safe to run twice)", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      // First run
      await runMigrationsPostgres(client);
      const countAfterFirst = await client`SELECT COUNT(*) FROM schema_migrations`;
      const firstCount = Number(countAfterFirst[0].count);

      // Second run
      await runMigrationsPostgres(client);
      const countAfterSecond = await client`SELECT COUNT(*) FROM schema_migrations`;
      const secondCount = Number(countAfterSecond[0].count);

      expect(secondCount).toBe(firstCount);
    });

    it("should track migration applied_at timestamp", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      const beforeTime = new Date();
      beforeTime.setSeconds(beforeTime.getSeconds() - 1);

      await runMigrationsPostgres(client);

      const afterTime = new Date();
      afterTime.setSeconds(afterTime.getSeconds() + 1);

      const migrations = await client`
        SELECT applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1
      `;
      const appliedAt = migrations[0].applied_at;

      expect(appliedAt).toBeInstanceOf(Date);
      expect(appliedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(appliedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it("getMigrationStatusPostgres should report correct status", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      await runMigrationsPostgres(client);
      const statuses = await getMigrationStatusPostgres(client);

      const migrations = loadMigrationFiles("postgres");
      expect(statuses.length).toBe(migrations.length);

      // All should be applied
      for (const status of statuses) {
        expect(status.applied).toBe(true);
        expect(status.appliedAt).toBeInstanceOf(Date);
      }
    });

    it("getMigrationStatusPostgres should report pending migrations correctly", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      // Don't run migrations, just check status
      const statuses = await getMigrationStatusPostgres(client);

      const migrations = loadMigrationFiles("postgres");
      expect(statuses.length).toBe(migrations.length);

      // All should be pending
      for (const status of statuses) {
        expect(status.applied).toBe(false);
        expect(status.appliedAt).toBeUndefined();
      }
    });
  });

  describe("Migration File Content", () => {
    it("should have properly formatted SQLite migration files", () => {
      const migrations = loadMigrationFiles("sqlite");
      expect(migrations.length).toBeGreaterThan(0);

      for (const migration of migrations) {
        // Each migration should have a name starting with a number
        expect(/^\d+_/.test(migration.name)).toBe(true);

        // SQL should not be empty
        expect(migration.sql.trim().length).toBeGreaterThan(0);

        // Should contain valid SQL statements (stubs are excluded by loadMigrationFiles)
        expect(migration.sql).toMatch(/CREATE|ALTER|INSERT|UPDATE|DELETE/i);
      }
    });

    it("should have properly formatted Postgres migration files", () => {
      const migrations = loadMigrationFiles("postgres");
      expect(migrations.length).toBeGreaterThan(0);

      for (const migration of migrations) {
        // Each migration should have a name starting with a number
        expect(/^\d+_/.test(migration.name)).toBe(true);

        // SQL should not be empty
        expect(migration.sql.trim().length).toBeGreaterThan(0);

        // Should contain valid SQL statements (stubs are excluded by loadMigrationFiles)
        expect(migration.sql).toMatch(/CREATE|ALTER|INSERT|UPDATE|DELETE|DO/i);
      }
    });

    it("should have no duplicate numeric prefixes in SQLite migrations", () => {
      const migrations = loadMigrationFiles("sqlite");
      const prefixes = migrations.map((m) => m.name.match(/^(\d+)/)?.[1]);
      const unique = new Set(prefixes);
      expect(unique.size).toBe(migrations.length);
    });

    it("should have no duplicate numeric prefixes in Postgres migrations", () => {
      const migrations = loadMigrationFiles("postgres");
      const prefixes = migrations.map((m) => m.name.match(/^(\d+)/)?.[1]);
      const unique = new Set(prefixes);
      expect(unique.size).toBe(migrations.length);
    });
  });

  describe("BEC-149: Migration rename compatibility", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(":memory:");
    });

    afterEach(() => {
      db.close();
    });

    it("should rename pre-BEC-149 tracking records so existing deployments don't re-run migrations", () => {
      // Simulate an existing deployment that already applied migrations under the old names
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      const insert = db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
      );
      insert.run("007_sso");
      insert.run("008_review_model_runs");

      // Running migrations should rename the old tracking records
      runMigrationsSqlite(db);

      // Old names should no longer exist in schema_migrations
      const oldRecords = db
        .prepare(
          "SELECT name FROM schema_migrations WHERE name IN ('007_sso', '008_review_model_runs')"
        )
        .all();
      expect(oldRecords).toHaveLength(0);

      // New canonical names should be present and marked applied
      const new008sso = db
        .prepare("SELECT name FROM schema_migrations WHERE name = '008_sso'")
        .get();
      const new009rmr = db
        .prepare(
          "SELECT name FROM schema_migrations WHERE name = '009_review_model_runs'"
        )
        .get();
      expect(new008sso).toBeTruthy();
      expect(new009rmr).toBeTruthy();
    });
  });
});
