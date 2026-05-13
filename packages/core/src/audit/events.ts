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
 * BEC-207: emitted by AuthMonitor when `claude auth status` reports the
 * session has expired. Operational signal — the operator must run `claude
 * login` or configure CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY before
 * new pipeline runs will succeed.
 *
 * NOTE: this event is written via `logAuditEventUnchecked` (the bypass call
 * site list in CLAUDE.md), because session expiry is a base-tier operational
 * concern that any operator needs to see regardless of `audit-log` licensing.
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

/**
 * Tier 1a — emitted when the scratch-file denylist gate matches one or more
 * agent-added files and forces the PR to draft. Payload includes the matched
 * paths so operators can see the rate and categories. Capped at 50 paths to
 * keep the audit row bounded.
 */
export function pipelineScratchFilesBlockedEvent(args: {
  runId: string;
  issueId: string;
  files: string[];
}): AuditEvent {
  return base({
    eventType: "pipeline.scratch_files_blocked",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      files: args.files.slice(0, 50),
      truncated: args.files.length > 50,
      count: args.files.length,
    },
  });
}

/**
 * Tier 1b — emitted when the typecheck gate detects type errors on the agent's
 * diff before push. The runner forces draft + a `category: "typecheck"`
 * blocking finding from this signal; the audit event surfaces the rate so
 * operators can spot regressions in agent code-quality.
 */
export function pipelineTypecheckFailedEvent(args: {
  runId: string;
  issueId: string;
  errorCount: number;
  firstMessages: string[];
}): AuditEvent {
  return base({
    eventType: "pipeline.typecheck_failed",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      errorCount: args.errorCount,
      firstMessages: args.firstMessages.slice(0, 5),
    },
  });
}

/**
 * Tier 1c — emitted when the spec-vs-impl gate detects JSDoc references to
 * `config.X` / `opts.X` / etc. that aren't defined anywhere in the worktree.
 * The runner pushes one `category: "spec-vs-impl"` blocking finding per
 * undefined symbol; the audit event captures the list (capped at 20 tuples)
 * for rate-tracking.
 */
/**
 * Tier 3 — emitted when the auto-deep-review heuristic bumps
 * `deepReviewPasses` because the agent's diff exceeded one or more
 * thresholds (changedFiles / totalLines / newPublicExports). Lets operators
 * track the rate of auto-bumps and tune thresholds.
 */
export function pipelineAutoDeepReviewBumpedEvent(args: {
  runId: string;
  issueId: string;
  metrics: {
    changedFiles: number;
    totalLines: number;
    newPublicExports: number;
  };
  thresholds: {
    changedFiles: number;
    totalLines: number;
    newPublicExports: number;
  };
  from: number;
  to: number;
}): AuditEvent {
  return base({
    eventType: "pipeline.auto_deep_review_bumped",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      metrics: args.metrics,
      thresholds: args.thresholds,
      from: args.from,
      to: args.to,
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

/**
 * `ura start --tunnel <mode>` brought a public tunnel up. Emitted once per
 * successful start (including restarts after a tunnel failure). Payload
 * carries the public URL so operators can see what their daemon is
 * reachable as.
 */
export function tunnelStartedEvent(args: {
  provider: "cloudflare-quick" | "cloudflare-token";
  publicUrl: string;
  restartCount: number;
}): AuditEvent {
  return base({
    eventType: "tunnel.started",
    actor: "system",
    actorType: "system",
    payload: {
      provider: args.provider,
      publicUrl: args.publicUrl,
      restartCount: args.restartCount,
    },
  });
}

/**
 * `ura start` reloaded the user-level config without a restart. Payload
 * lists what changed so operators can spot unexpected mutations.
 */
export function configReloadedEvent(args: {
  added: string[];
  removed: string[];
  modifiedSafe: string[];
  modifiedUnsafe: string[];
  sha256: string;
}): AuditEvent {
  return base({
    eventType: "config.reloaded",
    actor: "system",
    actorType: "system",
    payload: {
      added: args.added,
      removed: args.removed,
      modifiedSafe: args.modifiedSafe,
      modifiedUnsafe: args.modifiedUnsafe,
      sha256: args.sha256,
    },
  });
}

/**
 * Tunnel child process exited — either gracefully (operator stopped the
 * daemon) or because the restart cap was hit. Payload carries the exit
 * code / signal so operators can spot tunnel-flap loops in the audit log.
 */
export function tunnelStoppedEvent(args: {
  provider: "cloudflare-quick" | "cloudflare-token";
  restartCount: number;
  exitCode: number | null;
  signal: string | null;
}): AuditEvent {
  return base({
    eventType: "tunnel.stopped",
    actor: "system",
    actorType: "system",
    payload: {
      provider: args.provider,
      restartCount: args.restartCount,
      exitCode: args.exitCode,
      signal: args.signal,
    },
  });
}

/**
 * `ura self-auth-linear` completed — the operator authorized urateam in
 * Linear and the CLI persisted the access token to `~/.urateam/.env`.
 *
 * Payload deliberately omits the access token. workspaceId / workspaceName
 * are operational metadata; they're not sensitive in the same way the
 * token is.
 */
export function linearOauthCompletedEvent(args: {
  workspaceId: string;
  workspaceName?: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "linear.oauth_completed",
    actor: args.actor,
    actorType: "cli",
    payload: {
      workspaceId: args.workspaceId,
      ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    },
  });
}

/**
 * `ura service install` succeeded — a platform service unit (launchd plist
 * or systemd-user .service) was written and loaded. Emitted opportunistically
 * from the CLI when the daemon DB already exists; never blocks the install.
 */
export function serviceInstalledEvent(args: {
  platform: "darwin" | "linux";
  unitPath: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "service.installed",
    actor: args.actor,
    actorType: "cli",
    payload: { platform: args.platform, unitPath: args.unitPath },
  });
}

/**
 * `ura service uninstall` succeeded — the unit file was removed and the
 * service stopped. Counterpart to `serviceInstalledEvent`.
 */
export function serviceUninstalledEvent(args: {
  platform: "darwin" | "linux";
  unitPath: string;
  actor: string;
}): AuditEvent {
  return base({
    eventType: "service.uninstalled",
    actor: args.actor,
    actorType: "cli",
    payload: { platform: args.platform, unitPath: args.unitPath },
  });
}

export function pipelineSpecVsImplFailedEvent(args: {
  runId: string;
  issueId: string;
  findings: Array<{
    filePath: string;
    promisedPrefix: string;
    promisedSymbol: string;
  }>;
}): AuditEvent {
  return base({
    eventType: "pipeline.spec_vs_impl_failed",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      findings: args.findings.slice(0, 20),
      truncated: args.findings.length > 20,
      count: args.findings.length,
    },
  });
}
