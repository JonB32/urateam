import type { AuditEvent } from "../types.js";
import { base } from "./internal.js";
import { getAuthExpiredMessages } from "./auth-error-messages.js";

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

// Shared helper for release-manager events scoped to a repo URL.
function releaseRepoEvent(
  eventType: AuditEvent["eventType"],
  repoUrl: string,
  payload: Record<string, unknown>,
): AuditEvent {
  return base({
    eventType,
    actor: "release-manager",
    actorType: "release-manager",
    scope: `repo:${repoUrl}`,
    payload,
  });
}

export function releaseFiredEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
  sha: string;
  mergedPrCount: number;
}): AuditEvent {
  return releaseRepoEvent("release.fired", args.repoUrl, {
    branch: args.branch,
    tag: args.tag,
    sha: args.sha,
    mergedPrCount: args.mergedPrCount,
  });
}

export function releaseSkippedEvent(args: {
  repoUrl: string;
  branch: string;
  reason: string;
}): AuditEvent {
  return releaseRepoEvent("release.skipped", args.repoUrl, {
    branch: args.branch,
    reason: args.reason,
  });
}

export function releaseApprovedEvent(args: {
  repoUrl: string;
  branch: string;
  approvedBy: string;
}): AuditEvent {
  // actor is the Slack user who approved, not the generic release-manager string.
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
  return releaseRepoEvent("release.tag_conflict", args.repoUrl, {
    branch: args.branch,
    tag: args.tag,
  });
}

export function releasePartialEvent(args: {
  repoUrl: string;
  branch: string;
  tag: string;
  attemptCount: number;
}): AuditEvent {
  return releaseRepoEvent("release.partial", args.repoUrl, {
    branch: args.branch,
    tag: args.tag,
    attemptCount: args.attemptCount,
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
  return releaseRepoEvent("qa.run_triggered", args.repoUrl, {
    branch: args.branch,
    workflow: args.workflow,
    runId: args.runId,
    sha: args.sha,
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
  return releaseRepoEvent("qa.run_completed", args.repoUrl, {
    branch: args.branch,
    runId: args.runId,
    conclusion: args.conclusion,
    durationMs: args.durationMs,
    synthetic: args.synthetic ?? false,
  });
}

export function qaGapIssueFiledEvent(args: {
  repoUrl: string;
  branch: string;
  workflowPath: string;
  linearIssueId: string;
}): AuditEvent {
  return releaseRepoEvent("qa.gap_issue_filed", args.repoUrl, {
    branch: args.branch,
    workflowPath: args.workflowPath,
    linearIssueId: args.linearIssueId,
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
  authMethod: "oauth-token" | "mounted-session";
}): AuditEvent {
  const { hint } = getAuthExpiredMessages(args.authMethod);
  return base({
    eventType: "claude.auth_expired",
    actor: "system",
    actorType: "system",
    payload: {
      detectedAt: args.detectedAt.toISOString(),
      authMethod: args.authMethod,
      hint,
    },
  });
}

/**
 * BEC-252 — emitted when a stuck `running` pipeline_run was successfully
 * recovered after a container restart (worktree + transcript both found
 * on disk, last stage is idempotent-safe). The run is marked `retriable`
 * and re-queued by the PM Agent's normal recovery sweep.
 */
export function restartInterruptRecoveredEvent(args: {
  runId: string;
  issueId: string;
  stage: string;
  worktreeExisted: boolean;
  transcriptExisted: boolean;
  restartGapMs: number;
}): AuditEvent {
  return base({
    eventType: "pipeline.restart_interrupt_recovered",
    actor: "pm-agent",
    actorType: "pm-agent",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      stage: args.stage,
      worktreeExisted: args.worktreeExisted,
      transcriptExisted: args.transcriptExisted,
      restartGapMs: args.restartGapMs,
    },
  });
}

// Shared helper for pipeline-tier gate events (system actor, run+issue scoped).
function pipelineTierEvent(
  eventType: AuditEvent["eventType"],
  runId: string,
  issueId: string,
  payload: Record<string, unknown>,
): AuditEvent {
  return base({
    eventType,
    actor: "system",
    actorType: "system",
    runId,
    issueId,
    payload,
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
  return pipelineTierEvent("pipeline.scratch_files_blocked", args.runId, args.issueId, {
    files: args.files.slice(0, 50),
    truncated: args.files.length > 50,
    count: args.files.length,
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
  return pipelineTierEvent("pipeline.typecheck_failed", args.runId, args.issueId, {
    errorCount: args.errorCount,
    firstMessages: args.firstMessages.slice(0, 5),
    truncated: args.firstMessages.length > 5,
  });
}

/**
 * Tier 1c — emitted when the spec-vs-impl gate detects JSDoc references to
 * `config.X` / `opts.X` / etc. that aren't defined anywhere in the worktree.
 * The runner pushes one `category: "spec-vs-impl"` blocking finding per
 * undefined symbol; the audit event captures the list (capped at 20 tuples)
 * for rate-tracking.
 */
export function pipelineSpecVsImplFailedEvent(args: {
  runId: string;
  issueId: string;
  findings: Array<{
    filePath: string;
    promisedPrefix: string;
    promisedSymbol: string;
  }>;
}): AuditEvent {
  return pipelineTierEvent("pipeline.spec_vs_impl_failed", args.runId, args.issueId, {
    findings: args.findings.slice(0, 20),
    truncated: args.findings.length > 20,
    count: args.findings.length,
  });
}

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
  return pipelineTierEvent("pipeline.auto_deep_review_bumped", args.runId, args.issueId, {
    metrics: args.metrics,
    thresholds: args.thresholds,
    from: args.from,
    to: args.to,
  });
}

/**
 * BEC-227 — a fresh per-run Agent SDK session was created on the first
 * resumable stage. The `sessionId` is the UUID the SDK generates on the
 * first `query()` call; downstream stages reuse it via `resume:`.
 */
export function agentSessionCreatedEvent(args: {
  runId: string;
  issueId: string;
  sessionId: string;
}): AuditEvent {
  return base({
    eventType: "pipeline.agent_session_created",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      runId: args.runId,
      issueId: args.issueId,
      sessionId: args.sessionId,
    },
  });
}

/**
 * BEC-227 — a downstream stage resumed the per-run SDK session. Payload
 * carries the stage name and the prior message count read from the
 * session JSONL transcript so operators can see how much context was
 * inherited from earlier stages.
 */
export function agentSessionResumedEvent(args: {
  runId: string;
  issueId: string;
  sessionId: string;
  stage: string;
  priorMessageCount: number;
}): AuditEvent {
  return base({
    eventType: "pipeline.agent_session_resumed",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      runId: args.runId,
      issueId: args.issueId,
      sessionId: args.sessionId,
      stage: args.stage,
      priorMessageCount: args.priorMessageCount,
    },
  });
}

/**
 * BEC-227 Phase 4 / Track B. The review-fix loop's branch decision — was
 * the surgical path taken (resume + findings + decisions prompt) or the
 * legacy path (full implement-template re-run)? Always emitted, even on
 * the legacy path, so operators can audit fallback rates.
 */
export function surgicalReviewFixEvent(args: {
  runId: string;
  issueId: string;
  path: "surgical" | "legacy";
  findingsCount: number;
  decisionPayloadBytes: number;
}): AuditEvent {
  return base({
    eventType: "pipeline.surgical_review_fix",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      runId: args.runId,
      issueId: args.issueId,
      path: args.path,
      findingsCount: args.findingsCount,
      decisionPayloadBytes: args.decisionPayloadBytes,
    },
  });
}

/**
 * BEC-227 — a stage attempted to resume the per-run session but the
 * underlying JSONL was missing, unreadable, or the SDK rejected the resume.
 * The runner fell back to a fresh session for this stage. `reason` captures
 * the failure mode so operators can spot tmpfs-loss / parse-error patterns.
 */
export function agentSessionMissingFallbackEvent(args: {
  runId: string;
  issueId: string;
  sessionId: string;
  reason: "jsonl-not-found" | "jsonl-parse-error" | "sdk-resume-error";
}): AuditEvent {
  return base({
    eventType: "pipeline.agent_session_missing_fallback",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      runId: args.runId,
      issueId: args.issueId,
      sessionId: args.sessionId,
      reason: args.reason,
    },
  });
}

/**
 * BEC-227 — emitted at boot when the session-volume check finds
 * `~/.claude/projects` on tmpfs, missing, or unwritable. Session JSONLs
 * won't survive container restarts in any of these cases, so the operator
 * must remount before resume becomes reliable.
 */
export function systemSessionVolumeWarningEvent(args: {
  projectsDir: string;
  reason: "tmpfs" | "write-test-failed" | "not-found";
}): AuditEvent {
  return base({
    eventType: "system.session_volume_warning",
    actor: "system",
    actorType: "system",
    payload: {
      projectsDir: args.projectsDir,
      reason: args.reason,
    },
  });
}

/**
 * BEC-222 — emitted when a stale remote branch (no active DB run, no open
 * PR) is detected at pipeline start. The branch is deleted and the run
 * proceeds from scratch. Payload includes the branch name so operators can
 * see the recovery rate and identify patterns.
 */
export function pipelineStaleBranchRecoveredEvent(args: {
  issueId: string;
  branch: string;
  runId: string;
}): AuditEvent {
  return base({
    eventType: "pipeline.stale_branch_recovered",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: { branch: args.branch },
  });
}

/**
 * BEC-222 — emitted when an existing remote branch causes a pipeline start
 * to be skipped because a live run or open PR already holds it. Surfaces
 * the previously-silent skip in the audit log so operators can diagnose
 * stalled issues.
 */
export function pipelineSkippedExistingBranchEvent(args: {
  issueId: string;
  branch: string;
  reason: "active-run" | "open-pr";
  activeRunId?: string;
  prNumber?: number;
}): AuditEvent {
  return base({
    eventType: "pipeline.skipped_existing_branch",
    actor: "system",
    actorType: "system",
    issueId: args.issueId,
    payload: {
      branch: args.branch,
      reason: args.reason,
      ...(args.activeRunId !== undefined ? { activeRunId: args.activeRunId } : {}),
      ...(args.prNumber !== undefined ? { prNumber: args.prNumber } : {}),
    },
  });
}

/**
 * BEC-268 — emitted when the executor catches "Session ID X is already in use"
 * from the SDK's stderr on a fresh-session attempt. A new UUID was minted and
 * persisted so the recovery loop can retry without hitting the same collision.
 */
export function agentSessionCollisionRecoveredEvent(args: {
  runId: string;
  issueId: string;
  stage: string;
  oldSessionId: string;
  newSessionId: string;
}): AuditEvent {
  return base({
    eventType: "pipeline.agent_session_collision_recovered",
    actor: "system",
    actorType: "system",
    runId: args.runId,
    issueId: args.issueId,
    payload: {
      runId: args.runId,
      issueId: args.issueId,
      stage: args.stage,
      oldSessionId: args.oldSessionId,
      newSessionId: args.newSessionId,
    },
  });
}
