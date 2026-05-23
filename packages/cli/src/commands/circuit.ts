import { Command } from "commander";
import {
  batchCountConsecutiveFailures,
  circuitBreakerState,
  createDb,
  pipelineRuns,
  type AnyDb,
} from "@urateam/core";

export interface CircuitListDeps {
  db: AnyDb;
  log: (msg: string) => void;
  maxConsecutiveFailures: number;
}

/**
 * BEC-236 — `ura circuit list`. Shows currently-circuit-broken issues,
 * derived from `batchCountConsecutiveFailures` (the same source of truth
 * the breaker itself uses), LEFT-JOINed against `circuit_breaker_state`
 * for the optional escalated_at / last_probe_at / probe_attempts columns.
 *
 * Issues without a state row (e.g. broken before BEC-236 shipped, or
 * after the operator manually deleted the row) are still listed — the
 * row presence is informational, not a precondition for visibility.
 */
export async function runCircuitList(deps: CircuitListDeps): Promise<void> {
  // Use selectDistinct for the candidate set — we only care about which
  // issue IDs have any pipeline_runs history at all.
  const allIssueRows = (await deps.db
    .selectDistinct({ issueId: pipelineRuns.issueId })
    .from(pipelineRuns)) as Array<{ issueId: string }>;
  const allIssueIds = allIssueRows.map((r) => r.issueId);

  if (allIssueIds.length === 0) {
    deps.log("No circuit-broken issues.");
    return;
  }

  const failureCounts = await batchCountConsecutiveFailures(deps.db, allIssueIds);
  const broken = allIssueIds
    .filter((id) => (failureCounts.get(id) ?? 0) >= deps.maxConsecutiveFailures)
    .map((id) => ({ id, failures: failureCounts.get(id) ?? 0 }));

  if (broken.length === 0) {
    deps.log("No circuit-broken issues.");
    return;
  }

  const stateRows = (await deps.db.select().from(circuitBreakerState)) as Array<{
    issueId: string;
    escalatedAt: Date;
    lastProbeAt: Date | null;
    probeAttempts: number;
  }>;
  const stateById = new Map(stateRows.map((s) => [s.issueId, s]));

  deps.log(
    "ISSUE              FAILURES  ESCALATED            LAST_PROBE           ATTEMPTS",
  );
  for (const b of broken.sort((a, b) => a.id.localeCompare(b.id))) {
    const s = stateById.get(b.id);
    const escalated = s ? s.escalatedAt.toISOString() : "(no state row)";
    const lastProbe = s?.lastProbeAt ? s.lastProbeAt.toISOString() : "-";
    const attempts = s ? String(s.probeAttempts) : "-";
    deps.log(
      `${b.id.padEnd(18)} ${String(b.failures).padEnd(9)} ${escalated.padEnd(20)} ${lastProbe.padEnd(20)} ${attempts}`,
    );
  }
}

/**
 * BEC-236 — `ura circuit` parent command. Subcommands: list, reset (added in
 * later tasks).
 */
export const circuitCommand = new Command("circuit")
  .description("Inspect and reset the PM consecutive-failures circuit breaker.");

circuitCommand
  .command("list")
  .description(
    "Show issues currently circuit-broken (≥ maxConsecutiveFailures consecutive failed runs).",
  )
  .action(async () => {
    const dbUrl = process.env.DATABASE_URL ?? "./urateam.db";
    const db = await createDb({ connectionString: dbUrl });
    const max = Number.parseInt(process.env.PM_MAX_CONSECUTIVE_FAILURES ?? "3", 10);
    const threshold = Number.isFinite(max) && max > 0 ? max : 3;
    await runCircuitList({ db, log: console.log, maxConsecutiveFailures: threshold });
  });
