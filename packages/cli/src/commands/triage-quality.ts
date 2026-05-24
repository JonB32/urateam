import { Command } from "commander";
import { createDb } from "@urateam/core";
import type { AnyDb, TriageQualityEvent } from "@urateam/core";
import { readTriageQualityEvents } from "@urateam/core";

// ─── Formatter ────────────────────────────────────────────────────────────────

/**
 * Format a list of triage quality events as human-readable text.
 * Exported for unit testing.
 */
export function formatTriageQualityText(
  events: TriageQualityEvent[],
  days: number,
  limit: number,
): string {
  const lines: string[] = [];
  lines.push(`Triage v2 prediction quality — last ${days} days`);
  lines.push("");

  if (events.length === 0) {
    lines.push(`No triage-quality events in the last ${days} days.`);
    return lines.join("\n");
  }

  const v2Events = events.filter((e) => e.payload.hasV2Prediction);
  const nonV2Count = events.length - v2Events.length;

  // ── Summary (single pass over v2Events) ──────────────────────────────────
  let sumPredicted = 0;
  let sumActual = 0;
  const intersectionRatios: number[] = [];
  const missRates: number[] = [];
  const unexpectedRates: number[] = [];
  const missedCounts = new Map<string, number>();
  const unexpectedCounts = new Map<string, number>();

  for (const e of v2Events) {
    const { predicted, actual, intersection, missed, unexpected } = e.payload;
    sumPredicted += predicted;
    sumActual += actual;
    const denom = Math.max(predicted, actual);
    if (denom > 0) intersectionRatios.push(intersection / denom);
    if (predicted > 0) missRates.push(missed.length / predicted);
    if (actual > 0) unexpectedRates.push(unexpected.length / actual);
    for (const f of missed) missedCounts.set(f, (missedCounts.get(f) ?? 0) + 1);
    for (const f of unexpected) unexpectedCounts.set(f, (unexpectedCounts.get(f) ?? 0) + 1);
  }

  const avgPredicted = v2Events.length ? sumPredicted / v2Events.length : 0;
  const avgActual = v2Events.length ? sumActual / v2Events.length : 0;
  const avgIntersectionRatio =
    intersectionRatios.length
      ? intersectionRatios.reduce((s, r) => s + r, 0) / intersectionRatios.length
      : 0;
  const avgMissRate =
    missRates.length
      ? missRates.reduce((s, r) => s + r, 0) / missRates.length
      : 0;
  const avgUnexpectedRate =
    unexpectedRates.length
      ? unexpectedRates.reduce((s, r) => s + r, 0) / unexpectedRates.length
      : 0;

  lines.push("Summary:");
  lines.push(`  Runs with v2 prediction:    ${v2Events.length}`);
  lines.push(`  Runs without v2 prediction:  ${nonV2Count}`);
  lines.push(`  Avg predicted count:        ${avgPredicted.toFixed(1)}`);
  lines.push(`  Avg actual count:           ${avgActual.toFixed(1)}`);
  lines.push(
    `  Avg intersection ratio:    ${Math.round(avgIntersectionRatio * 100)}%   (intersection / max(predicted, actual))`,
  );
  lines.push(
    `  Avg miss rate:             ${Math.round(avgMissRate * 100)}%   (missed.length / predicted)`,
  );
  lines.push(
    `  Avg unexpected rate:       ${Math.round(avgUnexpectedRate * 100)}%   (unexpected.length / actual)`,
  );
  lines.push("");

  // ── Top missed files ──────────────────────────────────────────────────────
  const topMissed = [...missedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  lines.push("Top missed files (predicted but not in diff):");
  if (topMissed.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [file, count] of topMissed) {
      lines.push(`  ${file.padEnd(50)}  ${count} run${count !== 1 ? "s" : ""}`);
    }
  }
  lines.push("");

  // ── Top unexpected files ──────────────────────────────────────────────────
  const topUnexpected = [...unexpectedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  lines.push("Top unexpected files (in diff but not predicted):");
  if (topUnexpected.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [file, count] of topUnexpected) {
      lines.push(`  ${file.padEnd(50)}  ${count} run${count !== 1 ? "s" : ""}`);
    }
  }
  lines.push("");

  // ── Recent runs ───────────────────────────────────────────────────────────
  lines.push("Recent runs (most recent first):");
  const recentEvents = events.slice(0, limit);
  for (const e of recentEvents) {
    const issueId = (e.issueId ?? "(unknown)").padEnd(10);
    const runId = e.runId ? e.runId.slice(0, 8) : "(unknown)";
    const { predicted, actual, intersection, hasV2Prediction } = e.payload;
    if (!hasV2Prediction) {
      lines.push(
        `  ${issueId}  run ${runId}  (no v2 prediction)  actual=${actual}`,
      );
    } else {
      const denom = Math.max(predicted, actual);
      const pct = denom > 0 ? Math.round((intersection / denom) * 100) : 100;
      lines.push(
        `  ${issueId}  run ${runId}  predicted=${predicted}  actual=${actual}  hit=${intersection}/${denom} (${pct}%)`,
      );
    }
  }

  return lines.join("\n");
}

// ─── Database helper ──────────────────────────────────────────────────────────

async function openDb(opts: { log: (msg: string) => void }): Promise<AnyDb> {
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    opts.log(
      "warning: DATABASE_URL is not set — defaulting to ./urateam.db",
    );
    return createDb({ connectionString: "./urateam.db" });
  }
  return createDb({ connectionString: conn });
}

// ─── Commander wiring ─────────────────────────────────────────────────────────

function fail(err: unknown): never {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
  process.exit(1);
}

export const triageQualityCommand = new Command("triage-quality")
  .description(
    "Show aggregated pm.triage_quality_score stats from the audit log",
  )
  .option("--days <n>", "time window in days", "7")
  .option("--limit <n>", "max events to print in the per-run table", "20")
  .option(
    "--format <fmt>",
    'output format: text or json (default: text)',
    "text",
  )
  .action(
    async (opts: { days: string; limit: string; format: string }) => {
      const days = Math.max(1, parseInt(opts.days, 10) || 7);
      const limit = Math.max(1, parseInt(opts.limit, 10) || 20);
      const format = opts.format === "json" ? "json" : "text";

      try {
        const db = await openDb({
          log: (msg) => process.stderr.write(msg + "\n"),
        });
        const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

        const events = await readTriageQualityEvents(db, {
          sinceMs,
          // Fetch up to 10× the display limit for summary stats accuracy
          limit: Math.max(limit * 10, 500),
        });

        if (format === "json") {
          process.stdout.write(JSON.stringify(events, null, 2) + "\n");
          return;
        }

        // text mode
        process.stdout.write(formatTriageQualityText(events, days, limit) + "\n");
      } catch (err) {
        fail(err);
      }
    },
  );
