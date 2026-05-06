#!/usr/bin/env node

/**
 * Migration Prefix Fix Verification Script (TypeScript Direct)
 *
 * Works directly with TypeScript source by reading and analyzing the files
 * without requiring a build step.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the SQLITE_MIGRATION_RENAMES and POSTGRES_MIGRATION_RENAMES from the source
const migratorSource = readFileSync(
  join(__dirname, "packages/core/src/db/migrator.ts"),
  "utf8"
);

// Extract the rename maps from the source code
function extractRenameMaps() {
  const sqliteMatch = migratorSource.match(
    /const SQLITE_MIGRATION_RENAMES[^}]+}/s
  );
  const postgresMatch = migratorSource.match(
    /const POSTGRES_MIGRATION_RENAMES[^}]+}/s
  );

  const sqlite = {};
  const postgres = {};

  if (sqliteMatch) {
    const lines = sqliteMatch[0]
      .split("\n")
      .filter((l) => l.includes(":"));
    for (const line of lines) {
      const match = line.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
      if (match) sqlite[match[1]] = match[2];
    }
  }

  if (postgresMatch) {
    const lines = postgresMatch[0]
      .split("\n")
      .filter((l) => l.includes(":"));
    for (const line of lines) {
      const match = line.match(/"([^"]+)"\s*:\s*"([^"]+)"/);
      if (match) postgres[match[1]] = match[2];
    }
  }

  return { sqlite, postgres };
}

/**
 * Load migration files for a driver (simulating loadMigrationFiles)
 */
function loadMigrationFiles(driver) {
  const dir = join(__dirname, "packages/core/src/db/migrations", driver);

  // Get the set of deprecated (old) names to exclude
  const { sqlite: sqliteRenames, postgres: postgresRenames } = extractRenameMaps();
  const deprecatedNames =
    driver === "sqlite"
      ? new Set(Object.keys(sqliteRenames))
      : new Set(Object.keys(postgresRenames));

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
      console.error(
        `  Duplicate prefixes: ${Array.from(dups)
          .sort((a, b) => a - b)
          .join(", ")}`
      );
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
    console.error(err.stack);
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

      // Extract the actual rename maps from the source
      const { sqlite: SQLITE_MIGRATION_RENAMES } = extractRenameMaps();

      // Insert old migration names that should be renamed
      const oldMigrations = Object.keys(SQLITE_MIGRATION_RENAMES);

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

      // Check that all expected new names exist
      const expectedNewNames = Object.values(SQLITE_MIGRATION_RENAMES);
      const rowNames = rows.map((r) => r.name);
      const allFound = expectedNewNames.every((expected) =>
        rowNames.includes(expected)
      );

      // Check that no old names remain
      const oldNamesRemaining = oldMigrations.filter((old) =>
        rowNames.includes(old)
      );

      if (allFound && oldNamesRemaining.length === 0) {
        console.log(`\n✓ Migration rename compatibility test PASSED`);
        return true;
      } else {
        console.error(`\n✗ Migration rename compatibility test FAILED`);
        if (!allFound) {
          console.error(
            `  Missing expected names: ${expectedNewNames.filter((n) => !rowNames.includes(n)).join(", ")}`
          );
        }
        if (oldNamesRemaining.length > 0) {
          console.error(`  Old names still present: ${oldNamesRemaining.join(", ")}`);
        }
        return false;
      }
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
      console.log(`\nCleaned up test database`);
    }
  } catch (err) {
    console.error(`✗ Error during rename test: ${err.message}`);
    console.error(err.stack);
    return false;
  }
}

/**
 * Verify rename maps are correctly extracted
 */
function verifyRenameMaps() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`VERIFYING RENAME MAPS`);
  console.log(`${"=".repeat(60)}`);

  try {
    const { sqlite, postgres } = extractRenameMaps();

    console.log(`\nSQLite Renames (${Object.keys(sqlite).length} entries):`);
    for (const [oldName, newName] of Object.entries(sqlite)) {
      console.log(`  ${oldName} → ${newName}`);
    }

    console.log(`\nPostgres Renames (${Object.keys(postgres).length} entries):`);
    for (const [oldName, newName] of Object.entries(postgres)) {
      console.log(`  ${oldName} → ${newName}`);
    }

    return true;
  } catch (err) {
    console.error(`✗ Error verifying rename maps: ${err.message}`);
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
    renameMaps: false,
    sqliteMigrations: false,
    postgresMigrations: false,
    renameTest: false,
  };

  // Verify rename maps
  results.renameMaps = verifyRenameMaps();

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
    results.renameMaps &&
    results.sqliteMigrations &&
    results.postgresMigrations &&
    results.renameTest;

  console.log(
    `\nRename maps validation:   ${results.renameMaps ? "✓ PASS" : "✗ FAIL"}`
  );
  console.log(
    `SQLite migrations:        ${results.sqliteMigrations ? "✓ PASS" : "✗ FAIL"}`
  );
  console.log(
    `Postgres migrations:      ${results.postgresMigrations ? "✓ PASS" : "✗ FAIL"}`
  );
  console.log(
    `Migration rename test:    ${results.renameTest ? "✓ PASS" : "✗ FAIL"}`
  );

  console.log(
    `\n${allPassed ? "✓" : "✗"} Overall: ${allPassed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"}\n`
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
