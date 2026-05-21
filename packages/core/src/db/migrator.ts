/**
 * Migration framework for Linear Agent Framework.
 *
 * Reads numbered SQL migration files from packages/core/src/db/migrations/{driver}/
 * and applies any that have not yet been recorded in the schema_migrations table.
 *
 * Design:
 *   - schema_migrations table is created before any migrations run.
 *   - Migration files are sorted by name (NNN_description.sql) so they apply in order.
 *   - Each applied migration is recorded atomically; a failed migration is not recorded.
 *   - SQLite ALTER TABLE does not support IF NOT EXISTS, so duplicate-column errors are
 *     caught and treated as a no-op (idempotent re-run safety).
 *   - Postgres migrations use DO $$ IF NOT EXISTS $$ guards for native idempotency.
 *
 * Numbering policy (enforced as of BEC-149):
 *   - Every migration file must have a unique NNN_ numeric prefix.
 *   - When adding a new migration, use max(existing prefix) + 1.
 *   - Never reuse or duplicate a prefix number — the migrator sorts files alphabetically
 *     so duplicate prefixes produce non-deterministic ordering.
 *
 * Tombstone files (BEC-149 rename history):
 *   - Files listed as keys in SQLITE_MIGRATION_RENAMES / POSTGRES_MIGRATION_RENAMES are
 *     "tombstones": their content has moved to the canonical new name.
 *   - Tombstones are SKIPPED during migration processing (no SQL is run, nothing recorded).
 *   - Before running any migration, the migrator renames schema_migrations rows from the
 *     old name to the new name so existing deployments automatically adopt the canonical
 *     numbering without re-running the migration content.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { Sql } from "postgres";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** A single migration file with its name and SQL content. */
export interface Migration {
  name: string;
  sql: string;
}

/** Status of a migration (applied or pending). */
export interface MigrationStatus {
  name: string;
  applied: boolean;
  appliedAt?: Date;
}

const CREATE_SCHEMA_MIGRATIONS_SQLITE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`;

const CREATE_SCHEMA_MIGRATIONS_POSTGRES = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

/**
 * BEC-149: Rename map for SQLite migrations.
 *
 * Keys are the old (duplicate-prefix) migration names that were renumbered.
 * Values are the canonical new names.
 *
 * On startup the migrator updates schema_migrations rows from old → new so that
 * existing deployments recognise the renamed files without re-running them.
 * The old files are kept as tombstones (comment-only) and are SKIPPED by the
 * migration runner; only the canonical-named files are processed.
 */
export const SQLITE_MIGRATION_RENAMES: Record<string, string> = {
  "007_sso": "008_sso",
  "008_review_model_runs": "009_review_model_runs",
  "009_release_manager": "010_release_manager",
  "010_qa_run_columns": "011_qa_run_columns",
  "011_qa_gap_issues": "012_qa_gap_issues",
  // BEC-149 follow-on: 3 migrations landed on main after the initial rename
  // map was written and re-introduced prefix collisions (012_qa_gap_issues
  // vs 012_stage_runs_cache_tokens, 013_missing_indexes vs 013_triage_results).
  // Renumbering them keeps prefix-unique invariant intact.
  "012_stage_runs_cache_tokens": "013_stage_runs_cache_tokens",
  "013_missing_indexes": "014_missing_indexes",
  "013_triage_results": "015_triage_results",
};

/**
 * BEC-149: Rename map for Postgres migrations.
 *
 * Same semantics as SQLITE_MIGRATION_RENAMES above.
 */
export const POSTGRES_MIGRATION_RENAMES: Record<string, string> = {
  "008_sso": "009_sso",
  "009_review_model_runs": "010_review_model_runs",
  "010_release_manager": "011_release_manager",
  "011_qa_run_columns": "012_qa_run_columns",
  "012_qa_gap_issues": "013_qa_gap_issues",
  // BEC-149 follow-on: 3 migrations landed on main after the initial rename
  // map was written and re-introduced prefix collisions on 013.
  "013_stage_runs_cache_tokens": "014_stage_runs_cache_tokens",
  "014_missing_indexes": "015_missing_indexes",
  "015_triage_results": "016_triage_results",
};

/**
 * Read all .sql migration files for a driver from the migrations subdirectory,
 * sorted by filename (ascending, so NNN prefix determines order).
 *
 * Tombstone files (those whose names appear as keys in the driver's rename map)
 * are included in the returned list so callers can distinguish them; the migration
 * runners skip them automatically.
 */
export function loadMigrationFiles(driver: "sqlite" | "postgres"): Migration[] {
  const dir = join(__dirname, "migrations", driver);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    // migrations directory missing — no migrations to run
    return [];
  }
  return files.map((file) => ({
    name: file.replace(/\.sql$/, ""),
    sql: readFileSync(join(dir, file), "utf8"),
  }));
}

/**
 * Return the active (non-tombstone) migrations for a driver.
 * These are the migrations that the runner will actually process.
 */
export function loadActiveMigrationFiles(
  driver: "sqlite" | "postgres"
): Migration[] {
  const renames =
    driver === "sqlite" ? SQLITE_MIGRATION_RENAMES : POSTGRES_MIGRATION_RENAMES;
  return loadMigrationFiles(driver).filter((m) => !(m.name in renames));
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a MigrationStatus array from the active migrations list and the
 * applied-name → timestamp map that each driver-specific status function
 * constructs. Shared between SQLite and Postgres implementations to avoid
 * duplication.
 */
function buildMigrationStatus(
  migrations: Migration[],
  appliedMap: Map<string, Date>
): MigrationStatus[] {
  // Include any applied migrations that no longer have a file (e.g., squashed)
  const allNames = new Set([
    ...migrations.map((m) => m.name),
    ...appliedMap.keys(),
  ]);

  return Array.from(allNames)
    .sort()
    .map((name) => ({
      name,
      applied: appliedMap.has(name),
      appliedAt: appliedMap.get(name),
    }));
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Run all pending migrations against a better-sqlite3 Database instance.
 * Creates schema_migrations table if it does not exist.
 */
export function runMigrationsSqlite(db: Database.Database): void {
  // Ensure tracking table exists
  db.exec(CREATE_SCHEMA_MIGRATIONS_SQLITE);

  // BEC-149: Rename old migration entries to their canonical names so that
  // existing deployments don't re-run migrations under the new filenames.
  const renameStmt = db.prepare(
    "UPDATE schema_migrations SET name = ? WHERE name = ?"
  );
  for (const [oldName, newName] of Object.entries(SQLITE_MIGRATION_RENAMES)) {
    renameStmt.run(newName, oldName);
  }

  // Only process active (non-tombstone) migrations
  const migrations = loadActiveMigrationFiles("sqlite");
  const getApplied = db.prepare(
    "SELECT name FROM schema_migrations WHERE name = ?"
  );
  const recordApplied = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)"
  );

  for (const migration of migrations) {
    const existing = getApplied.get(migration.name);
    if (existing) {
      continue; // already applied
    }

    try {
      // Execute each statement individually so we can catch column-exists errors.
      // Split on semicolons, strip comment lines from each chunk, then keep non-empty statements.
      // We must strip comments BEFORE checking for empty — a chunk that starts with "--" may
      // also contain valid SQL (e.g. the very first statement in a file that has a comment header).
      const statements = migration.sql
        .split(";")
        .map((s) =>
          s
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim()
        )
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        try {
          db.exec(stmt);
        } catch (err: unknown) {
          // SQLite has no IF NOT EXISTS for ALTER TABLE ADD COLUMN.
          // Treat "duplicate column name" as a no-op so re-running is safe.
          if (
            err instanceof Error &&
            err.message.includes("duplicate column name")
          ) {
            continue;
          }
          // Also handle "table X already exists" for idempotent CREATE TABLE
          if (
            err instanceof Error &&
            err.message.includes("already exists")
          ) {
            continue;
          }
          throw err;
        }
      }

      // Record as applied only after all statements succeed
      recordApplied.run(migration.name);
    } catch (err) {
      throw new Error(
        `Migration "${migration.name}" failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Return the status of every active migration file for SQLite.
 * Tombstone files (renamed migrations) are excluded from the status list.
 */
export function getMigrationStatusSqlite(
  db: Database.Database
): MigrationStatus[] {
  // Ensure tracking table exists before querying
  db.exec(CREATE_SCHEMA_MIGRATIONS_SQLITE);

  const migrations = loadActiveMigrationFiles("sqlite");
  const rows = db
    .prepare("SELECT name, applied_at FROM schema_migrations")
    .all() as Array<{ name: string; applied_at: number }>;
  const appliedMap = new Map(rows.map((r) => [r.name, new Date(r.applied_at * 1000)]));

  return buildMigrationStatus(migrations, appliedMap);
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/**
 * Run all pending migrations against a postgres.js Sql client.
 * Creates schema_migrations table if it does not exist.
 */
export async function runMigrationsPostgres(client: Sql): Promise<void> {
  // Ensure tracking table exists
  await client.unsafe(CREATE_SCHEMA_MIGRATIONS_POSTGRES);

  // BEC-149: Rename old migration entries to their canonical names so that
  // existing deployments don't re-run migrations under the new filenames.
  // All renames are independent, so run them in parallel for faster startup.
  await Promise.all(
    Object.entries(POSTGRES_MIGRATION_RENAMES).map(([oldName, newName]) =>
      client`UPDATE schema_migrations SET name = ${newName} WHERE name = ${oldName}`
    )
  );

  // Only process active (non-tombstone) migrations
  const migrations = loadActiveMigrationFiles("postgres");

  for (const migration of migrations) {
    const existing = await client`
      SELECT name FROM schema_migrations WHERE name = ${migration.name}
    `;
    if (existing.length > 0) {
      continue; // already applied
    }

    try {
      await client.unsafe(migration.sql);
      await client`
        INSERT INTO schema_migrations (name) VALUES (${migration.name})
        ON CONFLICT (name) DO NOTHING
      `;
    } catch (err) {
      throw new Error(
        `Migration "${migration.name}" failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Return the status of every active migration file for Postgres.
 * Tombstone files (renamed migrations) are excluded from the status list.
 */
export async function getMigrationStatusPostgres(
  client: Sql
): Promise<MigrationStatus[]> {
  // Ensure tracking table exists before querying
  await client.unsafe(CREATE_SCHEMA_MIGRATIONS_POSTGRES);

  const migrations = loadActiveMigrationFiles("postgres");
  const rows = await client<
    Array<{ name: string; applied_at: Date }>
  >`SELECT name, applied_at FROM schema_migrations`;

  const appliedMap = new Map(rows.map((r) => [r.name, r.applied_at]));

  return buildMigrationStatus(migrations, appliedMap);
}
