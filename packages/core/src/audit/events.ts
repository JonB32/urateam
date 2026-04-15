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

export function dashboardLoginEvent(args: {
  userId: string;
  email: string;
  workosUserId: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.login",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: {
      userId: args.userId,
      email: args.email,
      workosUserId: args.workosUserId,
    },
  });
}

export function dashboardLogoutEvent(args: {
  userId: string;
  email: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.logout",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: { userId: args.userId },
  });
}

export function dashboardLoginDeniedEvent(args: {
  email: string;
  reason: "domain-mismatch";
}): AuditEvent {
  return base({
    eventType: "dashboard.login_denied",
    actor: `dashboard:${args.email}`,
    actorType: "dashboard-user",
    payload: { reason: args.reason },
  });
}

export function dashboardGrantRoleEvent(args: {
  targetUserId: string;
  targetEmail: string;
  oldRole: string;
  newRole: string;
  actorUserId: string;
  actorEmail: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.manual_action",
    actor: `dashboard:${args.actorEmail}`,
    actorType: "dashboard-user",
    payload: {
      action: "grant_role",
      targetUserId: args.targetUserId,
      targetEmail: args.targetEmail,
      oldRole: args.oldRole,
      newRole: args.newRole,
      actorUserId: args.actorUserId,
    },
  });
}

export function dashboardRevokeRoleEvent(args: {
  targetUserId: string;
  targetEmail: string;
  oldRole: string;
  newRole: string;
  actorUserId: string;
  actorEmail: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.manual_action",
    actor: `dashboard:${args.actorEmail}`,
    actorType: "dashboard-user",
    payload: {
      action: "revoke_role",
      targetUserId: args.targetUserId,
      targetEmail: args.targetEmail,
      oldRole: args.oldRole,
      newRole: args.newRole,
      actorUserId: args.actorUserId,
    },
  });
}

export function dashboardBootstrapAdminEvent(args: {
  targetUserId: string;
  targetEmail: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.manual_action",
    actor: "system",
    actorType: "system",
    payload: {
      action: "bootstrap_admin",
      targetUserId: args.targetUserId,
      targetEmail: args.targetEmail,
      envVarMatched: true,
    },
  });
}

export function dashboardRetryRunEvent(args: {
  runId: string;
  issueId: string;
  previousStatus: string;
  actorUserId: string;
  actorEmail: string;
}): AuditEvent {
  return base({
    eventType: "dashboard.manual_action",
    actor: `dashboard:${args.actorEmail}`,
    actorType: "dashboard-user",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      action: "retry_run",
      previousStatus: args.previousStatus,
      actorUserId: args.actorUserId,
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

export function policyPathBlockedEvent(args: {
  runId: string;
  path: string;
  pattern: string;
  hadOverride: boolean;
}): AuditEvent {
  return base({
    eventType: "policy.path_blocked",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    payload: { path: args.path, pattern: args.pattern, hadOverride: args.hadOverride },
  });
}

export function policyCostExceededEvent(args: {
  runId: string;
  tokensUsed: number;
  limit: number;
  stage: string;
  hadOverride: boolean;
}): AuditEvent {
  return base({
    eventType: "policy.cost_exceeded",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    payload: {
      tokensUsed: args.tokensUsed,
      limit: args.limit,
      stage: args.stage,
      hadOverride: args.hadOverride,
    },
  });
}

export function policyOverrideUsedEvent(args: {
  runId: string;
  issueId: string;
  gateType: "path" | "cost";
  label: string;
}): AuditEvent {
  return base({
    eventType: "policy.override_used",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: { gateType: args.gateType, label: args.label },
  });
}

export function policyReviewersRequestedEvent(args: {
  runId: string;
  prUrl: string;
  users: string[];
  teams: string[];
}): AuditEvent {
  return base({
    eventType: "policy.reviewers_requested",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    payload: { prUrl: args.prUrl, users: args.users, teams: args.teams },
  });
}
