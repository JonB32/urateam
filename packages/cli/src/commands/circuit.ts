import { Command } from "commander";
import { LinearClient } from "@linear/sdk";
import {
  batchCountConsecutiveFailures,
  circuitBreakerState,
  createDb,
  deleteFailedRunsForIssue,
  logAuditEventUnchecked,
  pipelineRuns,
  pmCircuitBreakerResetManualEvent,
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

export interface CircuitResetDeps {
  db: AnyDb;
  log: (msg: string) => void;
  issueId: string;
  linearClient: any; // LinearClient | minimal mock
  scope?: "single" | "bulk";
}

export interface CircuitResetResult {
  issueId: string;
  failedRunsDeleted: number;
}

/**
 * BEC-236 — `ura circuit reset <id>`. Clears the breaker for one issue:
 *
 *   1. Inside one DB transaction: cascade-delete agent_logs → stage_runs
 *      → failed pipeline_runs, drop the circuit_breaker_state row.
 *   2. Outside the transaction: if a state row WAS present, strip the
 *      Tier-5-added `needs-design` label via Linear updateIssue. Outside
 *      the tx because Linear is external — its failure shouldn't roll
 *      back the local DB cleanup.
 *   3. Emit `pm.circuit_breaker_reset_manual` audit event.
 *
 * `completed` runs are NEVER deleted. Issues without a state row keep
 * their needs-design label (preserves human/triage-added gates).
 */
export async function runCircuitReset(deps: CircuitResetDeps): Promise<CircuitResetResult> {
  const { db, log, issueId, linearClient } = deps;
  const scope = deps.scope ?? "single";

  // 1) Cascade-delete failed runs + state row inside a single DB transaction.
  //    Returns whether a state row was present (drives the Linear label-strip)
  //    and the count of deleted pipeline_runs rows.
  const { hadStateRow, failedRunCount } = await deleteFailedRunsForIssue(db, issueId);

  // 2) Linear label strip — only if state row WAS present (don't touch
  // human-added needs-design).
  if (hadStateRow) {
    try {
      const issue = await linearClient.issue(issueId);
      const labelConn = await issue.labels();
      const surviving = labelConn.nodes
        .filter((l: { name: string }) => l.name.toLowerCase() !== "needs-design")
        .map((l: { id: string }) => l.id);
      await linearClient.updateIssue(issue.id, { labelIds: surviving });
    } catch (err) {
      // Don't fail the CLI command on Linear errors — log + continue.
      log(
        `warning: failed to remove needs-design label for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3) Audit event.
  try {
    await logAuditEventUnchecked(
      db,
      pmCircuitBreakerResetManualEvent({ issueId, scope, failedRunsDeleted: failedRunCount }),
    );
  } catch (err) {
    log(
      `warning: failed to log audit event for ${issueId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log(`circuit reset: ${issueId} — deleted ${failedRunCount} failed pipeline_runs row(s)`);
  return { issueId, failedRunsDeleted: failedRunCount };
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

circuitCommand
  .command("reset")
  .description("Clear the breaker for an issue or all currently-broken issues.")
  .argument("[issueId]", "Issue ID (e.g. BEC-1). Omit when using --all (added in Task 12).")
  .option("--all", "Reset every currently-broken issue (Task 12 — not yet implemented).")
  .option("--yes", "Skip the bulk confirmation prompt (Task 12).")
  .action(async (issueId: string | undefined, opts: { all?: boolean; yes?: boolean }) => {
    if (opts.all) {
      console.error("ura circuit reset --all: not yet implemented (Task 12)");
      process.exit(1);
    }
    if (!issueId) {
      console.error("ura circuit reset: pass an issue ID (or use --all once implemented)");
      process.exit(1);
    }
    const dbUrl = process.env.DATABASE_URL ?? "./urateam.db";
    const db = await createDb({ connectionString: dbUrl });
    const linearApiKey = process.env.LINEAR_API_KEY;
    if (!linearApiKey) {
      console.error("ura circuit reset: LINEAR_API_KEY env var required");
      process.exit(1);
    }
    const linearClient = new LinearClient({ apiKey: linearApiKey });
    await runCircuitReset({ db, log: console.log, issueId, linearClient });
  });
