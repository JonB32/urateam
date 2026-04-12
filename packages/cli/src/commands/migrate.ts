import { Command } from "commander";
import Database from "better-sqlite3";
import postgres from "postgres";
import {
  runMigrationsSqlite,
  runMigrationsPostgres,
  getMigrationStatusSqlite,
  getMigrationStatusPostgres,
  type MigrationStatus,
} from "@urateam/core";

function detectDriver(connectionString: string): "sqlite" | "postgres" {
  if (
    connectionString.startsWith("postgres://") ||
    connectionString.startsWith("postgresql://")
  ) {
    return "postgres";
  }
  return "sqlite";
}

function printStatus(statuses: MigrationStatus[]): void {
  if (statuses.length === 0) {
    console.log("No migration files found.");
    return;
  }

  const pending = statuses.filter((s) => !s.applied);
  const applied = statuses.filter((s) => s.applied);

  console.log(`\nMigration status (${applied.length} applied, ${pending.length} pending):\n`);

  for (const s of statuses) {
    const marker = s.applied ? "✓" : "○";
    const dateStr = s.appliedAt
      ? `  [applied ${s.appliedAt.toISOString()}]`
      : "  [pending]";
    console.log(`  ${marker} ${s.name}${dateStr}`);
  }
  console.log();
}

export const migrateCommand = new Command("migrate")
  .description("Manage database migrations")
  .option(
    "--db <url>",
    "Database connection string (default: DATABASE_URL env var)"
  )
  .addCommand(
    new Command("status")
      .description("Show which migrations have been applied and which are pending")
      .option("--db <url>", "Database connection string")
      .action(async (opts: { db?: string }) => {
        const url =
          opts.db ?? process.env.DATABASE_URL;
        if (!url) {
          console.error(
            "Error: provide --db <url> or set DATABASE_URL environment variable."
          );
          process.exit(1);
        }

        const driver = detectDriver(url);

        try {
          let statuses: MigrationStatus[];
          if (driver === "postgres") {
            const client = postgres(url);
            statuses = await getMigrationStatusPostgres(client);
            await client.end();
          } else {
            const db = new Database(url);
            statuses = getMigrationStatusSqlite(db);
            db.close();
          }
          printStatus(statuses);
        } catch (err) {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
          process.exit(1);
        }
      })
  )
  .addCommand(
    new Command("run")
      .description("Apply all pending migrations")
      .option("--db <url>", "Database connection string")
      .action(async (opts: { db?: string }) => {
        const url = opts.db ?? process.env.DATABASE_URL;
        if (!url) {
          console.error(
            "Error: provide --db <url> or set DATABASE_URL environment variable."
          );
          process.exit(1);
        }

        const driver = detectDriver(url);
        console.log(`Running migrations against ${driver} database...`);

        try {
          if (driver === "postgres") {
            const client = postgres(url);
            // Show status before
            const before = await getMigrationStatusPostgres(client);
            const pending = before.filter((s) => !s.applied);
            if (pending.length === 0) {
              console.log("All migrations already applied. Nothing to do.");
              await client.end();
              return;
            }
            console.log(`Applying ${pending.length} pending migration(s)...`);
            for (const m of pending) {
              console.log(`  → ${m.name}`);
            }
            await runMigrationsPostgres(client);
            console.log("Done.");
            await client.end();
          } else {
            const db = new Database(url);
            // Show status before
            const before = getMigrationStatusSqlite(db);
            const pending = before.filter((s) => !s.applied);
            if (pending.length === 0) {
              console.log("All migrations already applied. Nothing to do.");
              db.close();
              return;
            }
            console.log(`Applying ${pending.length} pending migration(s)...`);
            for (const m of pending) {
              console.log(`  → ${m.name}`);
            }
            runMigrationsSqlite(db);
            console.log("Done.");
            db.close();
          }
        } catch (err) {
          console.error(
            `Migration failed: ${err instanceof Error ? err.message : String(err)}`
          );
          process.exit(1);
        }
      })
  )
  .action(async function (this: Command) {
    // Default action: show help when called without subcommand
    this.help();
  });
