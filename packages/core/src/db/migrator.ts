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
 * Read all .sql migration files for a driver from the migrations subdirectory,
 * sorted by filename (ascending, so NNN prefix determines order).
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

  const migrations = loadMigrationFiles("sqlite");
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
 * Return the status of every migration file for SQLite.
 */
export function getMigrationStatusSqlite(
  db: Database.Database
): MigrationStatus[] {
  // Ensure tracking table exists before querying
  db.exec(CREATE_SCHEMA_MIGRATIONS_SQLITE);

  const migrations = loadMigrationFiles("sqlite");
  const rows = db
    .prepare("SELECT name, applied_at FROM schema_migrations")
    .all() as Array<{ name: string; applied_at: number }>;
  const appliedMap = new Map(rows.map((r) => [r.name, new Date(r.applied_at * 1000)]));

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
// Postgres
// ---------------------------------------------------------------------------

/**
 * Run all pending migrations against a postgres.js Sql client.
 * Creates schema_migrations table if it does not exist.
 */
export async function runMigrationsPostgres(client: Sql): Promise<void> {
  // Ensure tracking table exists
  await client.unsafe(CREATE_SCHEMA_MIGRATIONS_POSTGRES);

  const migrations = loadMigrationFiles("postgres");

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
 * Return the status of every migration file for Postgres.
 */
export async function getMigrationStatusPostgres(
  client: Sql
): Promise<MigrationStatus[]> {
  // Ensure tracking table exists before querying
  await client.unsafe(CREATE_SCHEMA_MIGRATIONS_POSTGRES);

  const migrations = loadMigrationFiles("postgres");
  const rows = await client<
    Array<{ name: string; applied_at: Date }>
  >`SELECT name, applied_at FROM schema_migrations`;

  const appliedMap = new Map(rows.map((r) => [r.name, r.applied_at]));

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
