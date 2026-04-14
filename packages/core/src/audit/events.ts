import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../types.js";

function base(
  partial: Partial<AuditEvent> & Pick<AuditEvent, "eventType" | "actor" | "actorType">,
): AuditEvent {
  return {
    id: `evt_${randomUUID()}`,
    timestamp: new Date(),
    scope: partial.scope ?? null,
    runId: partial.runId ?? null,
    issueId: partial.issueId ?? null,
    inputTokens: partial.inputTokens ?? 0,
    outputTokens: partial.outputTokens ?? 0,
    payload: partial.payload ?? {},
    ...partial,
  };
}

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
    payload: { label: args.label, rationale: args.rationale.slice(0, 500) },
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

export function configLoadedEvent(args: {
  path: string;
  sha256: string;
  tier: string;
}): AuditEvent {
  return base({
    eventType: "config.loaded",
    actor: "system",
    actorType: "system",
    payload: { path: args.path, sha256: args.sha256, tier: args.tier },
  });
}
