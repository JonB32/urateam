import type { AuditEvent } from "../types.js";
import { base } from "./internal.js";

export function pmPromotedEvent(args: {
  issueId: string;
  fromState: string;
  toState: string;
  priority?: number;
  reason?: string;
}): AuditEvent {
  return base({
    eventType: "pm.issue_promoted",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: {
      fromState: args.fromState,
      toState: args.toState,
      priority: args.priority,
      reason: args.reason,
    },
  });
}

export function pmDeprioritizedEvent(args: {
  issueId: string;
  oldPriority: number | null;
  newPriority: number;
  approvalId: string;
}): AuditEvent {
  return base({
    eventType: "pm.issue_deprioritized",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: {
      oldPriority: args.oldPriority,
      newPriority: args.newPriority,
      approvalId: args.approvalId,
    },
  });
}

export function pmCancelledEvent(args: {
  issueId: string;
  approvalId: string;
  reason: string;
}): AuditEvent {
  return base({
    eventType: "pm.issue_cancelled",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: { approvalId: args.approvalId, reason: args.reason },
  });
}

export function pmAgentBranchSweptEvent(args: {
  branch: string;
  ageDays: number;
  reason: string;
}): AuditEvent {
  return base({
    eventType: "pm.agent_branch_swept",
    actor: "pm-agent",
    actorType: "pm-agent",
    payload: {
      branch: args.branch,
      ageDays: args.ageDays,
      reason: args.reason,
    },
  });
}

/**
 * Operator-initiated single-run stop. `mode` records whether the stage was
 * interrupted mid-stream ("cancel") or allowed to finish before skipping the
 * rest of the pipeline ("graceful").
 */
export function runCancelledEvent(args: {
  runId: string;
  issueId: string;
  actor: string;
  actorType: "dashboard-user" | "cli" | "slack" | "system";
  mode: "cancel" | "graceful";
  reason?: string;
}): AuditEvent {
  return base({
    eventType: "run.cancelled",
    actor: args.actor,
    actorType: args.actorType,
    runId: args.runId,
    issueId: args.issueId,
    payload: { mode: args.mode, reason: args.reason },
  });
}

/**
 * Operator-initiated container-wide halt. Records the count of in-flight runs
 * that were cancelled at halt time (each individual cancel also emits its own
 * `run.cancelled` event with the same actor).
 */
export function systemHaltedEvent(args: {
  actor: string;
  actorType: "dashboard-user" | "cli" | "slack" | "system";
  cancelledRunIds: string[];
  reason?: string;
}): AuditEvent {
  return base({
    eventType: "system.halted",
    actor: args.actor,
    actorType: args.actorType,
    payload: {
      cancelledRunIds: args.cancelledRunIds,
      cancelledCount: args.cancelledRunIds.length,
      reason: args.reason,
    },
  });
}

export function pmTriageClassifiedEvent(args: {
  issueId: string;
  label: string;
  rationale: string;
}): AuditEvent {
  return base({
    eventType: "pm.triage_classified",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    // Truncate rationale to 500 chars to keep the audit payload bounded
    payload: { label: args.label, rationale: args.rationale.slice(0, 500) },
  });
}

export function pmRecoveredLongRunningEvent(args: {
  issueId: string;
  runId: string;
  startedAt: Date;
  stuckRunAgeMinutes: number;
  targetState: string;
}): AuditEvent {
  return base({
    eventType: "pm.recovered_long_running",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    runId: args.runId,
    payload: {
      startedAt: args.startedAt.toISOString(),
      stuckRunAgeMinutes: args.stuckRunAgeMinutes,
      targetState: args.targetState,
    },
  });
}

export function pmSkippedCircuitBreakerEvent(args: {
  issueId: string;
  failureCount: number;
  threshold: number;
  source: "promote" | "start-todo";
}): AuditEvent {
  return base({
    eventType: "pm.skipped_circuit_breaker",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: {
      failureCount: args.failureCount,
      threshold: args.threshold,
      source: args.source,
    },
  });
}

export function budgetRefusedEvent(args: {
  scope: string;
  scopeType: "global" | "team" | "repo";
  tokensUsed: number;
  limit: number;
  utilization: number;
  refusedRunId?: string;
}): AuditEvent {
  return base({
    eventType: "budget.run_refused",
    actor: "pm-agent",
    actorType: "pm-agent",
    scope: args.scope,
    runId: args.refusedRunId ?? null,
    payload: {
      scopeType: args.scopeType,
      tokensUsed: args.tokensUsed,
      limit: args.limit,
      utilization: args.utilization,
    },
  });
}

export function licenseValidationFailedEvent(args: {
  invalidReason: "missing" | "expired" | "bad-signature" | "wrong-issuer";
  expiredAt?: Date;
}): AuditEvent {
  return base({
    eventType: "license.validation_failed",
    actor: "system",
    actorType: "system",
    payload: {
      invalidReason: args.invalidReason,
      expiredAt: args.expiredAt?.toISOString(),
    },
  });
}

/**
 * Tier 5 — emitted when an issue trips the consecutive-failures circuit
 * breaker (≥ maxConsecutiveFailures failed pipeline runs in a row) and the
 * PM Agent escalates it to needs-design. Carries the truncated error
 * message from the most-recent failed run so operators can see what kept
 * failing without opening the run logs.
 */
export function pmEscalatedToNeedsDesignEvent(args: {
  issueId: string;
  failureCount: number;
  errorMessage: string | null;
}): AuditEvent {
  return base({
    eventType: "pm.escalated_to_needs_design",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: {
      failureCount: args.failureCount,
      errorMessage: args.errorMessage
        ? args.errorMessage.slice(0, 500)
        : null,
    },
  });
}

/** BEC-236 — PM tick selected this issue for a half-open circuit-breaker
 * probe. The breaker is currently engaged (≥ maxConsecutiveFailures), but
 * the cooldown window has elapsed and the per-tick probe cap allows it
 * through. */
export function pmCircuitBreakerProbeEvent(args: {
  issueId: string;
  consecutiveFailures: number;
  /**
   * Minutes since this issue's previous probe. `-1` when there is no
   * previous probe (= this is the first probe for the issue). NOT the age
   * since the last failure — that would require a separate per-issue
   * query and wasn't worth the N+1.
   */
  lastProbeAgeMin: number;
  probeAttempts: number;
}): AuditEvent {
  return base({
    eventType: "pm.circuit_breaker_probe",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: {
      consecutiveFailures: args.consecutiveFailures,
      lastProbeAgeMin: args.lastProbeAgeMin,
      probeAttempts: args.probeAttempts,
    },
  });
}

/** BEC-236 — A probe run reached terminal `completed` status, so the
 * circuit_breaker_state row was deleted and the Tier-5-added `needs-design`
 * label was removed. */
export function pmCircuitBreakerRecoveredEvent(args: {
  issueId: string;
  probeAttempts: number;
}): AuditEvent {
  return base({
    eventType: "pm.circuit_breaker_recovered",
    actor: "pm-agent",
    actorType: "pm-agent",
    issueId: args.issueId,
    payload: {
      probeAttempts: args.probeAttempts,
    },
  });
}

/** BEC-236 — `ura circuit reset` cleared the breaker for an issue. */
export function pmCircuitBreakerResetManualEvent(args: {
  issueId: string;
  scope: "single" | "bulk";
  failedRunsDeleted: number;
}): AuditEvent {
  return base({
    eventType: "pm.circuit_breaker_reset_manual",
    actor: "ura-cli",
    actorType: "cli",
    issueId: args.issueId,
    payload: {
      scope: args.scope,
      failedRunsDeleted: args.failedRunsDeleted,
    },
  });
}

/**
 * Tier 6e — emitted after each successful push. Records how closely triage
 * v2's `affectedFiles` prediction matched the actual changed files in the
 * final diff. When `hasV2Prediction` is false the triage stage ran v1 and
 * the prediction fields are zeroed out.
 *
 * Payload is bounded: `missed` and `unexpected` are capped at 50 paths each
 * to keep the audit row within the ~2 KB target.
 */
export function pmTriageQualityScoreEvent(args: {
  runId: string;
  issueId: string;
  hasV2Prediction: boolean;
  predicted: number;
  actual: number;
  intersection: number;
  missed: string[];
  unexpected: string[];
}): AuditEvent {
  return base({
    eventType: "pm.triage_quality_score",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      hasV2Prediction: args.hasV2Prediction,
      predicted: args.predicted,
      actual: args.actual,
      intersection: args.intersection,
      missed: args.missed.slice(0, 50),
      unexpected: args.unexpected.slice(0, 50),
    },
  });
}
