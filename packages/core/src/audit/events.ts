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
    // (target max audit event JSON size ~2KB; most rationale strings are <100 chars).
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

export function releaseFiredEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
  sha: string;
  mergedPrCount: number;
}): AuditEvent {
  return base({
    eventType: "release.fired",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: {
      branch: args.branch,
      tag: args.tag,
      sha: args.sha,
      mergedPrCount: args.mergedPrCount,
    },
  });
}

export function releaseSkippedEvent(args: {
  repoUrl: string;
  branch: string;
  reason: string;
}): AuditEvent {
  return base({
    eventType: "release.skipped",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, reason: args.reason },
  });
}

export function releaseApprovedEvent(args: {
  repoUrl: string;
  branch: string;
  approvedBy: string;
}): AuditEvent {
  return base({
    eventType: "release.approved",
    actor: `slack:${args.approvedBy}`,
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, approvedBy: args.approvedBy },
  });
}

export function releaseTagConflictEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
}): AuditEvent {
  return base({
    eventType: "release.tag_conflict",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, tag: args.tag },
  });
}

export function releasePartialEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
  attemptCount: number;
}): AuditEvent {
  return base({
    eventType: "release.partial",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: { branch: args.branch, tag: args.tag, attemptCount: args.attemptCount },
  });
}

export function slackPostFailedEvent(args: {
  channel: string;
  reason: string;
}): AuditEvent {
  return base({
    eventType: "slack.post_failed",
    actor: "release-manager",
    actorType: "release-manager",
    payload: { channel: args.channel, reason: args.reason },
  });
}

export function qaRunTriggeredEvent(args: {
  repoUrl: string;
  branch: string;
  workflow: string;
  runId: number;
  sha: string;
}): AuditEvent {
  return base({
    eventType: "qa.run_triggered",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: {
      branch: args.branch,
      workflow: args.workflow,
      runId: args.runId,
      sha: args.sha,
    },
  });
}

export function qaRunCompletedEvent(args: {
  repoUrl: string;
  branch: string;
  runId: number;
  conclusion: "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "skipped" | "stale" | "neutral";
  durationMs: number;
  /** Set to true when we synthesize a timeout (GitHub didn't conclude the run). */
  synthetic?: boolean;
}): AuditEvent {
  return base({
    eventType: "qa.run_completed",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: {
      branch: args.branch,
      runId: args.runId,
      conclusion: args.conclusion,
      durationMs: args.durationMs,
      synthetic: args.synthetic ?? false,
    },
  });
}

export function qaGapIssueFiledEvent(args: {
  repoUrl: string;
  branch: string;
  workflowPath: string;
  linearIssueId: string;
}): AuditEvent {
  return base({
    eventType: "qa.gap_issue_filed",
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${args.repoUrl}`,
    payload: {
      branch: args.branch,
      workflowPath: args.workflowPath,
      linearIssueId: args.linearIssueId,
    },
  });
}

export function reviewFanoutFallbackUsedEvent(args: {
  runId: string;
  prNumber: number;
  fallbackModels: string[];
}): AuditEvent {
  return base({
    eventType: "review.fanout_fallback_used",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    payload: {
      prNumber: args.prNumber,
      fallbackModels: args.fallbackModels,
      fallbackCount: args.fallbackModels.length,
    },
  });
}

export function reviewModelLowOutputRatioEvent(args: {
  modelId: string;
  outputRatio: number;
  runs: number;
  threshold: number;
}): AuditEvent {
  return base({
    eventType: "review.model_low_output_ratio",
    actor: "system",
    actorType: "system",
    payload: {
      modelId: args.modelId,
      outputRatio: args.outputRatio,
      runs: args.runs,
      threshold: args.threshold,
    },
  });
}

/**
 * Emitted by AuthMonitor (BEC-207) when the mounted `claude` CLI session
 * fails the periodic `claude auth status` health-check. Only emitted on the
 * mounted-session path — env-var paths (CLAUDE_CODE_OAUTH_TOKEN /
 * ANTHROPIC_API_KEY) skip validation entirely and never emit this event.
 */
export function claudeAuthExpiredEvent(args: {
  detectedAt: Date;
}): AuditEvent {
  return base({
    eventType: "claude.auth_expired",
    actor: "system",
    actorType: "system",
    payload: {
      detectedAt: args.detectedAt.toISOString(),
      hint: "Run `claude login` in the container, or switch to CLAUDE_CODE_OAUTH_TOKEN (see deploy/CLAUDE_AUTH.md)",
    },
  });
}
