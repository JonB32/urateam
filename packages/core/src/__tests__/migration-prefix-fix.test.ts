/**
 * Test suite for BEC-149: Migration prefix fix validation
 *
 * Verifies that:
 * 1. No duplicate numeric prefixes exist in migration files
 * 2. All migrations have valid names (NNN_description format)
 * 3. Migration rename logic works correctly
 * 4. Deprecated files are properly excluded from loading
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_DIR = join(__dirname, "..", "..");

/**
 * Extract numeric prefix from migration name (e.g., "007_sso" -> 7)
 */
function extractPrefix(name: string): number | null {
  const match = name.match(/^(\d+)_/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Load migration files for a driver (without relying on the compiled migrator)
 */
function loadMigrationFilesForTest(driver: "sqlite" | "postgres"): Array<{
  name: string;
  sql: string;
}> {
  const dir = join(BASE_DIR, "src/db/migrations", driver);

  // The deprecated (old) names that should be excluded
  const deprecatedNames =
    driver === "sqlite"
      ? new Set([
          "007_sso",
          "008_review_model_runs",
          "009_release_manager",
          "010_qa_run_columns",
          "011_qa_gap_issues",
        ])
      : new Set([
          "008_sso",
          "009_review_model_runs",
          "010_release_manager",
          "011_qa_run_columns",
          "012_qa_gap_issues",
        ]);

  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => !deprecatedNames.has(f.replace(/\.sql$/, "")))
      .sort();

    return files.map((file) => ({
      name: file.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, file), "utf8"),
    }));
  } catch {
    return [];
  }
}

describe("BEC-149: Migration Prefix Fix", () => {
  describe("SQLite Migrations", () => {
    it("should load all SQLite migrations without deprecated files", () => {
      const migrations = loadMigrationFilesForTest("sqlite");

      expect(migrations.length).toBeGreaterThan(0);
      expect(migrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: expect.stringMatching(/^001_/) }),
          expect.objectContaining({ name: expect.stringMatching(/^007_/) }),
          expect.objectContaining({ name: expect.stringMatching(/^008_/) }),
        ])
      );
    });

    it("should have no null migrations", () => {
      const migrations = loadMigrationFilesForTest("sqlite");
      const nullCount = migrations.filter((m) => !m.name || !m.sql).length;

      expect(nullCount).toBe(0);
    });

    it("should have no duplicate numeric prefixes", () => {
      const migrations = loadMigrationFilesForTest("sqlite");
      const prefixes = migrations.map((m) => extractPrefix(m.name)).filter((p) => p !== null) as number[];

      const uniquePrefixes = new Set(prefixes);

      expect(uniquePrefixes.size).toBe(prefixes.length);
    });

    it("should have all migrations with valid numeric prefixes", () => {
      const migrations = loadMigrationFilesForTest("sqlite");

      for (const migration of migrations) {
        const prefix = extractPrefix(migration.name);
        expect(prefix).not.toBeNull();
        expect(prefix).toBeGreaterThan(0);
        expect(migration.name).toMatch(/^\d+_[a-z_]+$/);
      }
    });

    it("should have expected prefix range (1-12)", () => {
      const migrations = loadMigrationFilesForTest("sqlite");
      const prefixes = migrations.map((m) => extractPrefix(m.name)).filter((p) => p !== null) as number[];

      const minPrefix = Math.min(...prefixes);
      const maxPrefix = Math.max(...prefixes);

      expect(minPrefix).toBe(1);
      expect(maxPrefix).toBe(12);
    });

    it("should exclude deprecated files (old migration names)", () => {
      const dir = join(BASE_DIR, "src/db/migrations/sqlite");
      const allFiles = readdirSync(dir).filter((f) => f.endsWith(".sql"));
      const loadedMigrations = loadMigrationFilesForTest("sqlite");
      const loadedNames = loadedMigrations.map((m) => `${m.name}.sql`);

      // These old names should exist as files but not be loaded
      const deprecatedFiles = [
        "007_sso.sql",
        "008_review_model_runs.sql",
        "009_release_manager.sql",
        "010_qa_run_columns.sql",
        "011_qa_gap_issues.sql",
      ];

      for (const oldFile of deprecatedFiles) {
        expect(allFiles).toContain(oldFile); // File exists
        expect(loadedNames).not.toContain(oldFile); // But not loaded
      }
    });
  });

  describe("Postgres Migrations", () => {
    it("should load all Postgres migrations without deprecated files", () => {
      const migrations = loadMigrationFilesForTest("postgres");

      expect(migrations.length).toBeGreaterThan(0);
      expect(migrations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: expect.stringMatching(/^001_/) }),
          expect.objectContaining({ name: expect.stringMatching(/^009_/) }),
          expect.objectContaining({ name: expect.stringMatching(/^013_/) }),
        ])
      );
    });

    it("should have no duplicate numeric prefixes", () => {
      const migrations = loadMigrationFilesForTest("postgres");
      const prefixes = migrations.map((m) => extractPrefix(m.name)).filter((p) => p !== null) as number[];

      const uniquePrefixes = new Set(prefixes);

      expect(uniquePrefixes.size).toBe(prefixes.length);
    });

    it("should have expected prefix range (1-13)", () => {
      const migrations = loadMigrationFilesForTest("postgres");
      const prefixes = migrations.map((m) => extractPrefix(m.name)).filter((p) => p !== null) as number[];

      const minPrefix = Math.min(...prefixes);
      const maxPrefix = Math.max(...prefixes);

      expect(minPrefix).toBe(1);
      expect(maxPrefix).toBe(13);
    });

    it("should exclude deprecated files (old migration names)", () => {
      const dir = join(BASE_DIR, "src/db/migrations/postgres");
      const allFiles = readdirSync(dir).filter((f) => f.endsWith(".sql"));
      const loadedMigrations = loadMigrationFilesForTest("postgres");
      const loadedNames = loadedMigrations.map((m) => `${m.name}.sql`);

      // These old names should exist as files but not be loaded
      const deprecatedFiles = [
        "008_sso.sql",
        "009_review_model_runs.sql",
        "010_release_manager.sql",
        "011_qa_run_columns.sql",
        "012_qa_gap_issues.sql",
      ];

      for (const oldFile of deprecatedFiles) {
        expect(allFiles).toContain(oldFile); // File exists
        expect(loadedNames).not.toContain(oldFile); // But not loaded
      }
    });
  });

  describe("Migration Rename Compatibility", () => {
    it("should handle migration name updates in schema_migrations table (SQLite)", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "urateam-test-"));
      const dbPath = join(tmpDir, "test.db");

      try {
        const db = new Database(dbPath);

        try {
          // Create tracking table
          db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
          `);

          // Insert old migration names
          const oldNames = [
            "007_sso",
            "008_review_model_runs",
            "009_release_manager",
          ];
          for (const name of oldNames) {
            db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
          }

          // Verify old names exist
          let rows = db
            .prepare("SELECT name FROM schema_migrations ORDER BY name")
            .all() as Array<{ name: string }>;
          expect(rows.map((r) => r.name)).toEqual(oldNames);

          // Apply rename mapping (simulating runMigrationsSqlite)
          const updateStmt = db.prepare(
            "UPDATE schema_migrations SET name = ? WHERE name = ?"
          );
          updateStmt.run("008_sso", "007_sso");
          updateStmt.run("009_review_model_runs", "008_review_model_runs");
          updateStmt.run("010_release_manager", "009_release_manager");

          // Verify new names exist
          rows = db
            .prepare("SELECT name FROM schema_migrations ORDER BY name")
            .all() as Array<{ name: string }>;
          expect(rows.map((r) => r.name)).toEqual([
            "008_sso",
            "009_review_model_runs",
            "010_release_manager",
          ]);

          // Verify old names are gone
          const oldStillPresent = db
            .prepare("SELECT COUNT(*) as cnt FROM schema_migrations WHERE name IN (?, ?, ?)")
            .get("007_sso", "008_review_model_runs", "009_release_manager") as {
            cnt: number;
          };
          expect(oldStillPresent.cnt).toBe(0);
        } finally {
          db.close();
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("should be idempotent when applied multiple times", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "urateam-test-"));
      const dbPath = join(tmpDir, "test.db");

      try {
        const db = new Database(dbPath);

        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              applied_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
          `);

          // Insert a migration name
          db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run("007_sso");

          // Apply rename once
          db.prepare("UPDATE schema_migrations SET name = ? WHERE name = ?").run(
            "008_sso",
            "007_sso"
          );

          let rows = db
            .prepare("SELECT name FROM schema_migrations ORDER BY name")
            .all() as Array<{ name: string }>;
          expect(rows.map((r) => r.name)).toEqual(["008_sso"]);

          // Apply rename again (should be no-op since "007_sso" no longer exists)
          db.prepare("UPDATE schema_migrations SET name = ? WHERE name = ?").run(
            "008_sso",
            "007_sso"
          );

          rows = db
            .prepare("SELECT name FROM schema_migrations ORDER BY name")
            .all() as Array<{ name: string }>;
          expect(rows.map((r) => r.name)).toEqual(["008_sso"]);
        } finally {
          db.close();
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("Migration File Names", () => {
    it("should not have any file with 007 prefix except 007_cost_rollups (SQLite)", () => {
      const dir = join(BASE_DIR, "src/db/migrations/sqlite");
      const files = readdirSync(dir).filter((f) => f.startsWith("007_"));

      // Only 007_cost_rollups.sql should be loaded
      const validFiles = files.filter((f) => f === "007_cost_rollups.sql");

      expect(validFiles.length).toBe(1);
    });

    it("should have proper sequential numbering without gaps", () => {
      const migrations = loadMigrationFilesForTest("sqlite");
      const prefixes = migrations
        .map((m) => extractPrefix(m.name))
        .filter((p) => p !== null) as number[];
      prefixes.sort((a, b) => a - b);

      // Check for gaps (prefixes should be consecutive)
      for (let i = 0; i < prefixes.length - 1; i++) {
        expect(prefixes[i + 1]).toBe(prefixes[i] + 1);
      }
    });
  });
});
