import type { LinearClient } from "@linear/sdk";
import { circuitBreakerState } from "../../db/schema.js";
import type { AnyDb } from "../../db/client.js";
import { batchCountConsecutiveFailures } from "./db-queries.js";
import { recoverCircuitBreaker } from "./recover-circuit-breaker.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "PmAgent:sweep-recovery" });

export interface SweepRecoveredOptions {
  /**
   * Threshold the breaker uses. Issues whose consecutive-failure count has
   * dropped below this are recoverable.
   */
  maxConsecutiveFailures: number;
}

/**
 * BEC-236 — PM tick sweep that completes circuit-breaker recovery.
 *
 * The runner can't drive recovery itself because it has no `linearClient` in
 * scope (it talks to Linear only through the notifier, which doesn't expose
 * label edits). Instead, every PM tick scans `circuit_breaker_state` for
 * rows whose corresponding issue now has `batchCountConsecutiveFailures` <
 * threshold — i.e. a `completed` run has landed since the last failure
 * streak. Those rows are handed to `recoverCircuitBreaker`, which deletes
 * the row and strips the Tier-5-added `needs-design` label.
 *
 * Lag relative to run completion is at most one PM tick (~30 min). That's
 * fine for the recovery use case — the row stays visible to `ura circuit
 * list` until cleared, but nothing functional depends on instant cleanup.
 */
export async function sweepRecoveredCircuitBreakers(
  db: AnyDb,
  linearClient: LinearClient,
  opts: SweepRecoveredOptions,
): Promise<{ recovered: string[] }> {
  const rows = (await db
    .select({ issueId: circuitBreakerState.issueId })
    .from(circuitBreakerState)) as Array<{ issueId: string }>;
  if (rows.length === 0) return { recovered: [] };

  const issueIds = rows.map((r) => r.issueId);
  const counts = await batchCountConsecutiveFailures(db, issueIds);

  const recoverable = issueIds.filter(
    (id) => (counts.get(id) ?? 0) < opts.maxConsecutiveFailures,
  );
  if (recoverable.length === 0) return { recovered: [] };

  const recovered: string[] = [];
  for (const id of recoverable) {
    try {
      await recoverCircuitBreaker({ db, issueId: id, linearClient });
      recovered.push(id);
    } catch (err) {
      log.warn({ err, issueId: id }, "sweepRecoveredCircuitBreakers: recovery failed for issue");
    }
  }
  if (recovered.length > 0) {
    log.info({ recovered }, "circuit-breaker recovery sweep cleared issues");
  }
  return { recovered };
}
