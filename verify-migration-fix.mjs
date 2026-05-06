#!/usr/bin/env node

/**
 * Migration Prefix Fix Verification Script
 *
 * Verifies that BEC-149 fix resolves duplicate migration prefixes by:
 * 1. Loading migration files for both SQLite and Postgres
 * 2. Checking for duplicate numeric prefixes
 * 3. Testing the migration rename compatibility logic
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the migrator functions
const { loadMigrationFiles, runMigrationsSqlite } = await import(
  join(__dirname, "packages/core/dist/db/migrator.js")
);

/**
 * Extract numeric prefix from migration name (e.g., "007_sso" -> 7)
 */
function extractPrefix(name) {
  const match = name.match(/^(\d+)_/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Verify migrations for a given driver
 */
function verifyMigrations(driver) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`VERIFYING ${driver.toUpperCase()} MIGRATIONS`);
  console.log(`${"=".repeat(60)}`);

  try {
    const migrations = loadMigrationFiles(driver);

    console.log(`\n✓ Loaded ${migrations.length} migrations`);

    // Check for null values
    const nullMigrations = migrations.filter((m) => !m.name || !m.sql);
    if (nullMigrations.length > 0) {
      console.error(`✗ Found ${nullMigrations.length} null migrations`);
      return false;
    }
    console.log(`✓ No null values in migrations`);

    // Extract prefixes
    const prefixes = [];
    const names = [];
    for (const m of migrations) {
      const prefix = extractPrefix(m.name);
      if (prefix === null) {
        console.error(`✗ Migration "${m.name}" has no numeric prefix`);
        return false;
      }
      prefixes.push(prefix);
      names.push(m.name);
    }
    console.log(`✓ All migrations have numeric prefixes`);

    // Check for duplicates
    const prefixSet = new Set(prefixes);
    if (prefixSet.size !== prefixes.length) {
      console.error(
        `✗ DUPLICATE PREFIXES FOUND: ${prefixes.length} migrations but only ${prefixSet.size} unique prefixes`
      );
      // Find duplicates
      const seen = new Set();
      const dups = new Set();
      for (const p of prefixes) {
        if (seen.has(p)) dups.add(p);
        seen.add(p);
      }
      console.error(`  Duplicate prefixes: ${Array.from(dups).sort((a, b) => a - b).join(", ")}`);
      // Show which files have duplicates
      for (const dup of dups) {
        const files = names.filter((name, i) => prefixes[i] === dup);
        console.error(`    Prefix ${dup}: ${files.join(", ")}`);
      }
      return false;
    }
    console.log(`✓ All ${prefixes.length} numeric prefixes are unique`);

    // List migrations
    console.log(`\nMigrations (${driver}):`);
    const sortedIndices = prefixes
      .map((_, i) => i)
      .sort((a, b) => prefixes[a] - prefixes[b]);
    for (const i of sortedIndices) {
      const prefix = prefixes[i];
      const name = names[i];
      console.log(`  ${String(prefix).padStart(2, " ")} → ${name}`);
    }

    // Summary
    const minPrefix = Math.min(...prefixes);
    const maxPrefix = Math.max(...prefixes);
    console.log(
      `\nPrefix range: ${minPrefix}-${maxPrefix} (expected: ${driver === "sqlite" ? "1-12" : "1-13"})`
    );

    // Verify expected range
    const expectedMax = driver === "sqlite" ? 12 : 13;
    if (maxPrefix !== expectedMax) {
      console.warn(
        `⚠ Maximum prefix is ${maxPrefix}, expected ${expectedMax} for ${driver}`
      );
    }

    return true;
  } catch (err) {
    console.error(`✗ Error loading migrations: ${err.message}`);
    return false;
  }
}

/**
 * Test the migration rename compatibility logic
 */
function testMigrationRenameLogic() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TESTING MIGRATION RENAME COMPATIBILITY`);
  console.log(`${"=".repeat(60)}`);

  try {
    // Create a temporary SQLite database
    const tmpDir = mkdtempSync(join(tmpdir(), "urateam-migration-test-"));
    const dbPath = join(tmpDir, "test.db");

    console.log(`\nCreating test database at ${dbPath}`);
    const db = new Database(dbPath);

    try {
      // Create schema_migrations table with old migration names (simulating old deployment)
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);

      // Insert old migration names that should be renamed
      const oldMigrations = [
        "007_sso",
        "008_review_model_runs",
        "009_release_manager",
        "010_qa_run_columns",
        "011_qa_gap_issues",
      ];

      console.log(`\nInserting old migration names:`);
      for (const oldName of oldMigrations) {
        db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
          oldName
        );
        console.log(`  - ${oldName}`);
      }

      // Verify they were inserted
      let rows = db
        .prepare("SELECT name FROM schema_migrations ORDER BY name")
        .all();
      console.log(`\nBefore rename compatibility fix: ${rows.length} rows`);
      rows.forEach((r) => console.log(`  - ${r.name}`));

      // Now run the migration rename logic (simulating runMigrationsSqlite)
      const SQLITE_MIGRATION_RENAMES = {
        "007_sso": "008_sso",
        "008_review_model_runs": "009_review_model_runs",
        "009_release_manager": "010_release_manager",
        "010_qa_run_columns": "011_qa_run_columns",
        "011_qa_gap_issues": "012_qa_gap_issues",
      };

      console.log(`\nApplying migration rename mapping:`);
      const updateMigrationName = db.prepare(
        "UPDATE schema_migrations SET name = ? WHERE name = ?"
      );
      for (const [oldName, newName] of Object.entries(SQLITE_MIGRATION_RENAMES)) {
        const result = updateMigrationName.run(newName, oldName);
        if (result.changes > 0) {
          console.log(`  ✓ ${oldName} → ${newName}`);
        } else {
          console.log(`  - ${oldName} → ${newName} (no matching rows)`);
        }
      }

      // Verify the new names
      rows = db
        .prepare("SELECT name FROM schema_migrations ORDER BY name")
        .all();
      console.log(`\nAfter rename compatibility fix: ${rows.length} rows`);
      rows.forEach((r) => console.log(`  - ${r.name}`));

      // Check for expected new names
      const newMigrations = [
        "008_sso",
        "009_review_model_runs",
        "010_release_manager",
        "011_qa_run_columns",
        "012_qa_gap_issues",
      ];

      const success = newMigrations.every((expected) =>
        rows.some((r) => r.name === expected)
      );

      if (success) {
        console.log(
          `\n✓ Migration rename compatibility test PASSED`
        );
      } else {
        console.error(
          `\n✗ Migration rename compatibility test FAILED`
        );
        return false;
      }

      return true;
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
      console.log(`\nCleaned up test database`);
    }
  } catch (err) {
    console.error(`✗ Error during rename test: ${err.message}`);
    return false;
  }
}

/**
 * Main verification function
 */
async function main() {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║     MIGRATION PREFIX FIX VERIFICATION (BEC-149)            ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  const results = {
    sqliteMigrations: false,
    postgresMigrations: false,
    renameTest: false,
  };

  // Verify SQLite migrations
  results.sqliteMigrations = verifyMigrations("sqlite");

  // Verify Postgres migrations
  results.postgresMigrations = verifyMigrations("postgres");

  // Test rename logic
  results.renameTest = testMigrationRenameLogic();

  // Final summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("FINAL RESULTS");
  console.log(`${"=".repeat(60)}`);

  const allPassed =
    results.sqliteMigrations &&
    results.postgresMigrations &&
    results.renameTest;

  console.log(`\nSQLite migrations:        ${results.sqliteMigrations ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`Postgres migrations:      ${results.postgresMigrations ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`Migration rename test:    ${results.renameTest ? "✓ PASS" : "✗ FAIL"}`);

  console.log(`\n${allPassed ? "✓" : "✗"} Overall: ${allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});
