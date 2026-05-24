import { eq } from "drizzle-orm";
import type { LinearClient } from "@linear/sdk";
import { circuitBreakerState } from "../../db/schema.js";
import type { AnyDb } from "../../db/client.js";
import { createLogger } from "../../logger.js";
import { logAuditEventUnchecked } from "../../audit/writer.js";
import { pmCircuitBreakerRecoveredEvent } from "../../audit/events.js";

const log = createLogger({ component: "PmAgent:recover-breaker" });

export interface RecoverCircuitBreakerInput {
  db: AnyDb;
  /** Linear issue identifier (e.g. "BEC-1") — the human-facing identifier, NOT the UUID. */
  issueId: string;
  linearClient:
    | LinearClient
    | {
        issue: (id: string) => any;
        updateIssue: (id: string, payload: any) => any;
      };
}

/**
 * BEC-236 — invoked when a pipeline run reaches terminal `completed`
 * status. If the issue has a circuit_breaker_state row (i.e. we
 * Tier-5-escalated it earlier), drop the row and strip the
 * `needs-design` label. Idempotent and safe to call for any completed
 * run — early-returns when no state row exists, so human-added
 * needs-design labels are preserved.
 */
export async function recoverCircuitBreaker(
  input: RecoverCircuitBreakerInput,
): Promise<void> {
  const { db, issueId, linearClient } = input;

  const rows = (await db
    .select({ probeAttempts: circuitBreakerState.probeAttempts })
    .from(circuitBreakerState)
    .where(eq(circuitBreakerState.issueId, issueId))) as Array<{
    probeAttempts: number;
  }>;
  if (rows.length === 0) return; // not our escalation, leave label alone

  const probeAttempts = rows[0].probeAttempts;

  // Delete the state row first — if label removal fails, the next run will
  // re-attempt the label removal but the breaker state is already cleared.
  await db
    .delete(circuitBreakerState)
    .where(eq(circuitBreakerState.issueId, issueId));

  try {
    const issue = await (linearClient as any).issue(issueId);
    const labelConn = await issue.labels();
    const surviving = labelConn.nodes
      .filter((l: { name: string }) => l.name.toLowerCase() !== "needs-design")
      .map((l: { id: string }) => l.id);
    await (linearClient as any).updateIssue(issue.id, { labelIds: surviving });
  } catch (err) {
    log.warn(
      { err, issueId },
      "recoverCircuitBreaker: failed to remove needs-design label",
    );
  }

  try {
    await logAuditEventUnchecked(
      db,
      pmCircuitBreakerRecoveredEvent({ issueId, probeAttempts }),
    );
  } catch (err) {
    log.warn(
      { err, issueId },
      "recoverCircuitBreaker: failed to log audit event",
    );
  }
}
