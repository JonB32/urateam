import Database from "better-sqlite3";
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema.js";
import { _setSchemaDriver } from "./schema.js";
import { runMigrationsSqlite, runMigrationsPostgres } from "./migrator.js";

const fullSchema = schema;

export type SqliteDb = BetterSQLite3Database<typeof fullSchema>;
/** Postgres DB typed against the unified schema via any to avoid pg-vs-sqlite column type mismatch. */
export type PgDb = ReturnType<typeof drizzlePg> & { __driver: "postgres" };
export type Db = SqliteDb | PgDb;

/**
 * Escape-hatch type used when passing the Db union to Drizzle query
 * builders that expect a single concrete driver type. Both SQLite and
 * Postgres schemas have identical column structures, so the generated
 * SQL is correct for either driver at runtime.
 */
export type AnyDb = any;

/**
 * Describes a column added by a migration (for existing deployments).
 * A single entry here generates the correct DDL for both SQLite and Postgres.
 * Adding a new column requires exactly one entry in MIGRATION_COLUMNS.
 */
interface MigrationColumn {
  /** Table to alter */
  table: string;
  /** Column name (snake_case, as stored in DB) */
  column: string;
  /** Full type + constraint string for SQLite ALTER TABLE */
  sqliteType: string;
  /** Full type + constraint string for Postgres ALTER TABLE */
  pgType: string;
}

/**
 * Single unified migration list.
 * SQLite and Postgres migration statements are auto-generated from this list.
 * To add a new column to an existing table: add ONE entry here.
 */
const MIGRATION_COLUMNS: MigrationColumn[] = [
  // BEC-87: auto-recover transient failures
  { table: "pipeline_runs", column: "retry_count", sqliteType: "INTEGER NOT NULL DEFAULT 0", pgType: "INTEGER NOT NULL DEFAULT 0" },
  // BEC-84: review-feedback support
  { table: "pipeline_runs", column: "run_type", sqliteType: "TEXT NOT NULL DEFAULT 'standard'", pgType: "TEXT NOT NULL DEFAULT 'standard'" },
  { table: "pipeline_runs", column: "parent_run_id", sqliteType: "TEXT", pgType: "TEXT" },
  { table: "pipeline_runs", column: "feedback_context", sqliteType: "TEXT", pgType: "TEXT" },
  // BEC-95: auto-merge audit log
  { table: "pipeline_runs", column: "auto_merged", sqliteType: "INTEGER", pgType: "BOOLEAN" },
  { table: "pipeline_runs", column: "auto_merge_reason", sqliteType: "TEXT", pgType: "TEXT" },
  // BEC-94: auto-commit quality metric
  { table: "pipeline_runs", column: "auto_committed", sqliteType: "INTEGER", pgType: "BOOLEAN" },
  { table: "pipeline_runs", column: "linear_team_id", sqliteType: "TEXT", pgType: "TEXT" },
  // Feature 4.4: RBAC
  {
    table: "dashboard_users",
    column: "role",
    sqliteType: "TEXT NOT NULL DEFAULT 'viewer'",
    pgType: "TEXT NOT NULL DEFAULT 'viewer'",
  },
];

/**
 * Generates CREATE TABLE statements for both SQLite and Postgres from a single
 * template, substituting driver-specific types for timestamps and booleans.
 *
 * This is the single source of truth for table DDL.
 * Both drivers use this function — no separate DDL blocks.
 */
export function getCreateTablesDDL(driver: "sqlite" | "postgres"): string {
  const ts = driver === "postgres" ? "TIMESTAMPTZ" : "INTEGER";
  const now = driver === "postgres" ? "now()" : "unixepoch()";
  const bool = driver === "postgres" ? "BOOLEAN" : "INTEGER";
  const num = driver === "postgres" ? "DOUBLE PRECISION" : "REAL";

  return `
  CREATE TABLE IF NOT EXISTS pipeline_runs (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    issue_title TEXT NOT NULL,
    pipeline_key TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT,
    status TEXT NOT NULL,
    started_at ${ts} NOT NULL DEFAULT (${now}),
    completed_at ${ts},
    pr_url TEXT,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    current_stage_index INTEGER,
    resume_payload TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    run_type TEXT NOT NULL DEFAULT 'standard',
    parent_run_id TEXT,
    feedback_context TEXT,
    auto_merged ${bool},
    auto_merge_reason TEXT,
    auto_committed ${bool},
    linear_team_id TEXT
  );

  CREATE TABLE IF NOT EXISTS stage_runs (
    id TEXT PRIMARY KEY,
    pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at ${ts} NOT NULL DEFAULT (${now}),
    completed_at ${ts},
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0,
    handoff_artifact TEXT,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_logs (
    id TEXT PRIMARY KEY,
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    timestamp ${ts} NOT NULL DEFAULT (${now}),
    type TEXT NOT NULL,
    content TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_stage_runs_pipeline_run_id ON stage_runs(pipeline_run_id);
  CREATE INDEX IF NOT EXISTS idx_agent_logs_stage_run_id ON agent_logs(stage_run_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_issue_id ON pipeline_runs(issue_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

  CREATE TABLE IF NOT EXISTS pm_approvals (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    slack_message_ts TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at ${ts} NOT NULL DEFAULT (${now}),
    resolved_at ${ts}
  );

  CREATE INDEX IF NOT EXISTS idx_pm_approvals_status ON pm_approvals(status);

  CREATE TABLE IF NOT EXISTS active_work (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    issue_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    files_modified TEXT,
    started_at ${ts} NOT NULL DEFAULT (${now}),
    updated_at ${ts} NOT NULL DEFAULT (${now})
  );

  CREATE INDEX IF NOT EXISTS idx_active_work_issue_id ON active_work(issue_id);

  CREATE TABLE IF NOT EXISTS webhook_dedup (
    id TEXT PRIMARY KEY,
    expires_at ${ts} NOT NULL
  );

  CREATE TABLE IF NOT EXISTS budget_alerts (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    scope TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    fired_at ${ts} NOT NULL,
    UNIQUE(date, scope, threshold)
  );

  CREATE INDEX IF NOT EXISTS idx_budget_alerts_date_scope ON budget_alerts(date, scope);

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    timestamp ${ts} NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    scope TEXT,
    run_id TEXT,
    issue_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_type_ts ON audit_events(event_type, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_scope_ts ON audit_events(scope, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_events_run_id ON audit_events(run_id);

  CREATE TABLE IF NOT EXISTS dashboard_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    workos_user_id TEXT,
    created_at ${ts} NOT NULL,
    last_login_at ${ts},
    role TEXT NOT NULL DEFAULT 'viewer'
  );

  CREATE TABLE IF NOT EXISTS dashboard_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES dashboard_users(id),
    created_at ${ts} NOT NULL,
    expires_at ${ts} NOT NULL,
    last_seen_at ${ts} NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user_id ON dashboard_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expires_at ON dashboard_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS cost_rollups_daily (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    pipeline_key TEXT NOT NULL,
    linear_team_id TEXT,
    repo_url TEXT NOT NULL,
    runs INTEGER NOT NULL DEFAULT 0,
    prs_merged INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    dollars ${num} NOT NULL DEFAULT 0,
    time_saved_hours ${num} NOT NULL DEFAULT 0,
    computed_at ${ts} NOT NULL,
    UNIQUE (date, pipeline_key, linear_team_id, repo_url)
  );
  CREATE INDEX IF NOT EXISTS idx_cost_rollups_date ON cost_rollups_daily(date);
  CREATE INDEX IF NOT EXISTS idx_cost_rollups_date_pipeline ON cost_rollups_daily(date, pipeline_key);

  CREATE TABLE IF NOT EXISTS review_model_runs (
    id TEXT PRIMARY KEY,
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    status TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    truncated_files INTEGER NOT NULL DEFAULT 0,
    started_at ${ts},
    completed_at ${ts}
  );

  CREATE INDEX IF NOT EXISTS idx_review_model_runs_stage_run_id
    ON review_model_runs(stage_run_id);
`;
}

/** Generate SQLite ALTER TABLE statements from the unified migration list. */
export function getMigrateSqlite(): string[] {
  return MIGRATION_COLUMNS.map(
    ({ table, column, sqliteType }) =>
      `ALTER TABLE ${table} ADD COLUMN ${column} ${sqliteType}`,
  );
}

/** Generate a Postgres DO $$ ... $$ migration block from the unified migration list. */
export function getMigratePostgres(): string {
  const checks = MIGRATION_COLUMNS.map(
    ({ table, column, pgType }) =>
      `  IF NOT EXISTS (SELECT 1 FROM information_schema.columns\n` +
      `      WHERE table_name = '${table}' AND column_name = '${column}') THEN\n` +
      `    ALTER TABLE ${table} ADD COLUMN ${column} ${pgType};\n` +
      `  END IF;`,
  ).join("\n");
  return `DO $$\nBEGIN\n${checks}\nEND $$;`;
}

export interface CreateDbOptions {
  /** Auto-detected from connectionString if not provided. */
  driver?: "sqlite" | "postgres";
  /** File path / ":memory:" for SQLite, or connection URL for Postgres. */
  connectionString: string;
}

function detectDriver(connectionString: string): "sqlite" | "postgres" {
  if (
    connectionString.startsWith("postgres://") ||
    connectionString.startsWith("postgresql://")
  ) {
    return "postgres";
  }
  return "sqlite";
}

/** Tag used to identify the driver at runtime. */
const DB_DRIVER_TAG = Symbol("dbDriver");

export async function createDb(options: CreateDbOptions): Promise<Db> {
  const driver = options.driver ?? detectDriver(options.connectionString);

  if (driver === "postgres") {
    // Set the schema driver so crossTimestamp.toDriver() serialises Dates as
    // ISO-8601 strings, which Postgres accepts for TIMESTAMPTZ columns.
    _setSchemaDriver("postgres");
    const client = postgres(options.connectionString);
    await client.unsafe(getCreateTablesDDL("postgres"));
    await client.unsafe(getMigratePostgres());
    await runMigrationsPostgres(client);
    const db = drizzlePg(client, { schema: fullSchema as any });
    (db as any)[DB_DRIVER_TAG] = "postgres";
    return db as unknown as PgDb;
  }

  // SQLite: serialise Dates as epoch-second integers (default).
  _setSchemaDriver("sqlite");
  const sqlite = new Database(options.connectionString);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(getCreateTablesDDL("sqlite"));
  for (const stmt of getMigrateSqlite()) {
    try { sqlite.exec(stmt); } catch { /* column already exists */ }
  }
  runMigrationsSqlite(sqlite);
  const db = drizzleSqlite(sqlite, { schema: fullSchema });
  (db as any)[DB_DRIVER_TAG] = "sqlite";
  return db;
}

/** Check if a Db instance is backed by Postgres. */
export function isPostgres(db: Db): boolean {
  return (db as any)[DB_DRIVER_TAG] === "postgres";
}

/**
 * Returns a SQL expression that formats a crossTimestamp column as 'YYYY-MM-DD'.
 *
 * - SQLite:   `date(col, 'unixepoch')` — column is INTEGER epoch seconds
 * - Postgres: `to_char(col, 'YYYY-MM-DD')` — column is TIMESTAMPTZ
 */
export function sqlDateGroup(db: Db, col: any): SQL<string> {
  return isPostgres(db)
    ? sql<string>`to_char(${col}, 'YYYY-MM-DD')`
    : sql<string>`date(${col}, 'unixepoch')`;
}

/**
 * Returns a SQL expression that filters rows where a crossTimestamp column
 * is at or after `days` days ago.
 *
 * - SQLite:   `col >= unixepoch('now', '-N days')` — column is INTEGER epoch seconds
 * - Postgres: `col >= now() - interval 'N days'` — column is TIMESTAMPTZ
 */
export function sqlDaysAgoFilter(db: Db, col: any, days: number): SQL {
  return isPostgres(db)
    ? sql`${col} >= now() - interval '${sql.raw(String(days))} days'`
    : sql`${col} >= unixepoch('now', '-${sql.raw(String(days))} days')`;
}
