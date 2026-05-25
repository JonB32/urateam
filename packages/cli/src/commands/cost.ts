import { Command } from "commander";
import { createDb, backfillCostRollups } from "@urateam/core";
import type { AnyDb } from "@urateam/core";

async function openDb(opts: { log: (msg: string) => void }): Promise<AnyDb> {
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    opts.log("warning: DATABASE_URL is not set — defaulting to ./urateam.db");
    return createDb({ connectionString: "./urateam.db" });
  }
  return createDb({ connectionString: conn });
}

function fail(err: unknown): never {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
}

const backfillSubcommand = new Command("backfill")
  .description(
    "Backfill cost rollups for a given number of days (default: 365). " +
    "Requires the cost-roi enterprise license.",
  )
  .option("--days <n>", "number of UTC days to backfill ending yesterday", "365")
  .action(async (opts: { days: string }) => {
    const days = parseInt(opts.days, 10);
    if (!Number.isFinite(days) || days <= 0) {
      fail(`--days must be a positive integer, got: ${opts.days}`);
    }
    try {
      const db = await openDb({ log: (msg) => process.stderr.write(msg + "\n") });
      process.stdout.write(`Backfilling cost rollups for the last ${days} day(s)…\n`);
      const result = await backfillCostRollups(db, {}, days);
      process.stdout.write(
        `Done. Days processed: ${result.daysProcessed}, rows written: ${result.rowsWritten}\n`,
      );
    } catch (err) {
      fail(err);
    }
  });

export const costCommand = new Command("cost")
  .description("Cost rollup management commands")
  .addCommand(backfillSubcommand);
