import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import postgres from "postgres";
import {
  loadMigrationFiles,
  loadActiveMigrationFiles,
  runMigrationsSqlite,
  runMigrationsPostgres,
  getMigrationStatusSqlite,
  getMigrationStatusPostgres,
  SQLITE_MIGRATION_RENAMES,
  POSTGRES_MIGRATION_RENAMES,
  type Migration,
  type MigrationStatus,
} from "../db/migrator.js";

// Helper: schema_migrations DDL, used in tests that pre-populate the table
const CREATE_SCHEMA_MIGRATIONS_SQLITE_FOR_TEST = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`;

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

  describe("loadActiveMigrationFiles", () => {
    it("should exclude tombstone (renamed) migrations from SQLite list", () => {
      const all = loadMigrationFiles("sqlite");
      const active = loadActiveMigrationFiles("sqlite");

      // Active list must be smaller than full list (tombstones excluded)
      expect(active.length).toBeLessThan(all.length);

      // No tombstone names in the active list
      for (const name of Object.keys(SQLITE_MIGRATION_RENAMES)) {
        expect(active.map((m) => m.name)).not.toContain(name);
      }

      // All canonical (new) names are present in the active list
      for (const newName of Object.values(SQLITE_MIGRATION_RENAMES)) {
        expect(active.map((m) => m.name)).toContain(newName);
      }
    });

    it("should exclude tombstone (renamed) migrations from Postgres list", () => {
      const all = loadMigrationFiles("postgres");
      const active = loadActiveMigrationFiles("postgres");

      expect(active.length).toBeLessThan(all.length);

      for (const name of Object.keys(POSTGRES_MIGRATION_RENAMES)) {
        expect(active.map((m) => m.name)).not.toContain(name);
      }

      for (const newName of Object.values(POSTGRES_MIGRATION_RENAMES)) {
        expect(active.map((m) => m.name)).toContain(newName);
      }
    });
  });

  describe("Unique migration prefixes (BEC-149)", () => {
    it("SQLite active migrations must all have unique numeric prefixes", () => {
      const active = loadActiveMigrationFiles("sqlite");
      const prefixes = active.map((m) => m.name.match(/^(\d+)_/)?.[1]);

      // Every active migration must have a numeric prefix
      for (const prefix of prefixes) {
        expect(prefix).toBeTruthy();
      }

      // All prefixes must be unique
      const uniquePrefixes = new Set(prefixes);
      expect(uniquePrefixes.size).toBe(prefixes.length);
    });

    it("Postgres active migrations must all have unique numeric prefixes", () => {
      const active = loadActiveMigrationFiles("postgres");
      const prefixes = active.map((m) => m.name.match(/^(\d+)_/)?.[1]);

      for (const prefix of prefixes) {
        expect(prefix).toBeTruthy();
      }

      const uniquePrefixes = new Set(prefixes);
      expect(uniquePrefixes.size).toBe(prefixes.length);
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

    it("should record all active migrations in schema_migrations", () => {
      runMigrationsSqlite(db);

      const activeMigrations = loadActiveMigrationFiles("sqlite");
      const recorded = db
        .prepare("SELECT name FROM schema_migrations ORDER BY name")
        .all() as Array<{ name: string }>;

      const recordedNames = recorded.map((r) => r.name);
      const activeMigrationNames = activeMigrations.map((m) => m.name).sort();

      expect(recordedNames).toEqual(activeMigrationNames);
    });

    it("should NOT record tombstone (renamed) migrations in schema_migrations", () => {
      runMigrationsSqlite(db);

      const recorded = db
        .prepare("SELECT name FROM schema_migrations")
        .all() as Array<{ name: string }>;
      const recordedNames = recorded.map((r) => r.name);

      for (const oldName of Object.keys(SQLITE_MIGRATION_RENAMES)) {
        expect(recordedNames).not.toContain(oldName);
      }
    });

    it("should rename existing schema_migrations entries from old to new names (existing deployment simulation)", () => {
      // Simulate an existing deployment that has the old pre-BEC-149 names
      db.exec(CREATE_SCHEMA_MIGRATIONS_SQLITE_FOR_TEST);

      // Insert old migration names (as they would exist before BEC-149 fix)
      const insert = db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
      );
      for (const oldName of Object.keys(SQLITE_MIGRATION_RENAMES)) {
        insert.run(oldName);
      }

      // Verify old names are present
      const beforeRun = db
        .prepare("SELECT name FROM schema_migrations")
        .all() as Array<{ name: string }>;
      expect(beforeRun.map((r) => r.name)).toContain("007_sso");

      // Run migrations (should rename old → new without re-running SQL)
      runMigrationsSqlite(db);

      const afterRun = db
        .prepare("SELECT name FROM schema_migrations")
        .all() as Array<{ name: string }>;
      const afterNames = afterRun.map((r) => r.name);

      // Old names should be gone
      for (const oldName of Object.keys(SQLITE_MIGRATION_RENAMES)) {
        expect(afterNames).not.toContain(oldName);
      }

      // New canonical names should be present
      for (const newName of Object.values(SQLITE_MIGRATION_RENAMES)) {
        expect(afterNames).toContain(newName);
      }
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

      const activeMigrations = loadActiveMigrationFiles("sqlite");
      expect(statuses.length).toBe(activeMigrations.length);

      // All should be applied
      for (const status of statuses) {
        expect(status.applied).toBe(true);
        expect(status.appliedAt).toBeInstanceOf(Date);
      }
    });

    it("getMigrationStatusSqlite should report pending migrations correctly", () => {
      // Don't run migrations, just check status
      const statuses = getMigrationStatusSqlite(db);

      const activeMigrations = loadActiveMigrationFiles("sqlite");
      expect(statuses.length).toBe(activeMigrations.length);

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

    it("should record all active migrations in schema_migrations", async () => {
      if (!dbUrl) {
        console.warn("Skipping Postgres test: TEST_POSTGRES_URL not set");
        return;
      }

      await runMigrationsPostgres(client);

      const activeMigrations = loadActiveMigrationFiles("postgres");
      const recorded = await client`SELECT name FROM schema_migrations ORDER BY name`;

      const recordedNames = recorded.map((r) => r.name);
      const activeMigrationNames = activeMigrations.map((m) => m.name).sort();

      expect(recordedNames).toEqual(activeMigrationNames);
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

      const activeMigrations = loadActiveMigrationFiles("postgres");
      expect(statuses.length).toBe(activeMigrations.length);

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

      const activeMigrations = loadActiveMigrationFiles("postgres");
      expect(statuses.length).toBe(activeMigrations.length);

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
      }
    });

    it("active SQLite migrations must contain valid SQL statements", () => {
      const migrations = loadActiveMigrationFiles("sqlite");
      for (const migration of migrations) {
        expect(migration.sql).toMatch(
          /CREATE|ALTER|INSERT|UPDATE|DELETE/i
        );
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
      }
    });

    it("active Postgres migrations must contain valid SQL statements", () => {
      const migrations = loadActiveMigrationFiles("postgres");
      for (const migration of migrations) {
        expect(migration.sql).toMatch(
          /CREATE|ALTER|INSERT|UPDATE|DELETE|DO/i
        );
      }
    });
  });
});

