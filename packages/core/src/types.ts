import { z } from "zod";
import { ReleaseManagerConfigSchema } from "./release-manager/types.js";

// --- Stage Types ---
const StageTypeSchema = z.enum([
  "triage", "await-approval", "reproduce", "implement", "test", "review",
]);
export type StageType = z.infer<typeof StageTypeSchema>;

export const AGENT_STAGES: StageType[] = [
  "triage", "reproduce", "implement", "test", "review",
];

// --- Pipeline Config ---
const RetryStrategySchema = z.enum(["fix-and-retry", "escalate", "fail-fast"]);
export type RetryStrategy = z.infer<typeof RetryStrategySchema>;

const RetryConfigSchema = z.object({
  maxAttempts: z.number().int().min(0),
  strategy: RetryStrategySchema,
});
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

export const ReviewConfigSchema = z.object({
  requiredApprovals: z.number().int().min(0),
});
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

export const PipelineConfigSchema = z.object({
  name: z.string(),
  stages: z.array(StageTypeSchema).min(1),
  retry: RetryConfigSchema,
  review: ReviewConfigSchema,
  prStrategy: z.enum(["draft", "ready"]),
  /** Run a lightweight validation agent after each stage to verify handoff accuracy.
   *  Default: false. Set to true to opt in (adds ~15-20K tokens per run). */
  validateHandoffs: z.boolean().optional(),
  /** RALPH loop iterations for the implement stage. 0 disables. Default: 1.
   *  Set to 2 for more thorough requirements checking (adds ~100-200K tokens per iteration). */
  ralphIterations: z.number().int().min(0).max(5).optional(),
  /** Review-fix loop iterations. When review finds blocking issues, re-run implement→test→review.
   *  Default: 1, 0 disables. WARNING: compounds with ralphIterations — worst case is
   *  reviewFixIterations × (1 + ralphIterations) implement runs per fix cycle.
   *  Set to 2 for an extra fix pass (adds ~150-300K tokens per iteration). */
  reviewFixIterations: z.number().int().min(0).max(5).optional(),
  /** Deep review passes using 3 parallel sub-agents (reuse, quality, efficiency).
   *  Runs after the review-fix loop resolves blocking findings. Default: 0 (disabled).
   *  Set to 1 to opt in for critical pipelines (adds ~45-100K tokens per pass).
   *  Tier 3 auto-bumps this to at least 1 when `autoDeepReviewThresholds` fire. */
  deepReviewPasses: z.number().int().min(0).max(5).optional(),
  /** Hard cap on deep review passes. Prevents infinite loops. Default: 3. */
  maxDeepReviewPasses: z.number().int().min(1).max(10).optional(),
  /** Tier 3 — heuristic thresholds for auto-bumping `deepReviewPasses` to ≥1
   *  when the agent's diff is "non-trivial". Any one tripping is enough.
   *  Defaults: { newFiles: 5, totalLines: 200, newPublicExports: 2 }. Set
   *  individual values to a huge number to effectively disable that trigger,
   *  or use the `URATEAM_DISABLE_AUTO_DEEP_REVIEW=true` env var to disable
   *  the whole heuristic per-run. Requires `OPENROUTER_API_KEY` +
   *  `REVIEW_MODELS` configured for the deep-review fanout to actually run.  */
  autoDeepReviewThresholds: z
    .object({
      changedFiles: z.number().int().min(0),
      totalLines: z.number().int().min(0),
      newPublicExports: z.number().int().min(0),
    })
    .optional(),
  /** Tier 3 — when true (default), blocking findings from the deep-review
   *  loop are added to `unresolvedBlockingFindings`, forcing draft PRs.
   *  Set to false to keep deep-review findings advisory-only (the existing
   *  behavior pre-Tier 3).  */
  deepReviewFindingsAreBlocking: z.boolean().optional(),
  /** Auto-merge PRs when changes are trivial. Default: false (opt-in). */
  autoMerge: z.boolean().optional(),
  /** Max diff lines for auto-merge eligibility. Default: 200. */
  autoMergeMaxLines: z.number().int().min(1).optional(),
  /** File glob patterns that require manual review (skip auto-merge if any changed file matches).
   *  Example: ["**\/migrations\/**", "**\/*.env", "infra\/**"]  */
  autoMergeExcludePatterns: z.array(z.string()).optional(),
  /**
   * Advanced automerge criteria evaluated when GitHub sends a PR event (check_suite.completed,
   * status, pull_request.labeled, etc.).  All criteria must pass for the PR to be merged.
   * Requires GitHub App credentials (github config in ServerConfig).
   */
  autoMergeConfig: z.object({
    /** Minimum number of unique approving reviews required. Default: 0. */
    minimumApprovingReviews: z.number().int().min(0).optional(),
    /** Status check context names (or check run names) that must all report "success".
     *  Example: ["ci/tests", "security/snyk"]  */
    requiredStatusChecks: z.array(z.string()).optional(),
    /** Labels the PR must carry — all listed labels must be present. Default: [] */
    requiredLabels: z.array(z.string()).optional(),
    /** Allowed base branches for auto-merge. If empty, any base branch is allowed. */
    allowedBranches: z.array(z.string()).optional(),
    /** Merge method to use when merging the PR. Default: "squash". */
    mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  }).optional(),
  /** Maximum total tokens (input + output) allowed per pipeline run. Exceeding this aborts the run. */
  maxTokens: z.number().int().positive().optional(),
  /** Per-stage model overrides. Keys are stage names; values are model strings passed to the Agent SDK.
   *  Invalid model strings are passed through as-is (let the SDK error, no local validation).
   *  Example: { implement: "claude-opus-4-6", test: "claude-haiku-4-5" } */
  stageModels: z.record(z.string(), z.string()).optional(),
  /** Fail the pipeline run if the agent did not commit its work and auto-commit was triggered.
   *  When false (default), auto-commit is a silent safety net and the run continues normally.
   *  When true, triggering auto-commit is treated as a pipeline error so the issue surfaces immediately. */
  failOnAutoCommit: z.boolean().optional(),
  /** Optional org-policy guardrails (path blocklist, per-issue cost cap, mandatory reviewers). */
  policy: z.lazy(() => PolicySchema).optional(),
  /** Hours of engineer time saved when this pipeline merges a PR.
   *  Overrides costs.timeSavedPerPrDefault for this specific pipeline. */
  timeSavedPerPr: z.number().positive().optional(),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

// --- Org Policy ---
export const PolicySchema = z.object({
  pathBlocklist: z.array(z.string()).default([]),
  maxTokensPerIssue: z.number().int().positive().optional(),
  overrideLabel: z.string().min(1).default("policy-override"),
  mandatoryReviewers: z.object({
    users: z.array(z.string()).default([]),
    teams: z.array(z.string()).default([]),
  }).optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

// --- Trigger Map ---
export const TriggerMapSchema = z.object({
  start: z.string(),
  resume: z.string(),
  pause: z.string(),
  abort: z.string(),
});
export type TriggerMap = z.infer<typeof TriggerMapSchema>;

export const DEFAULT_TRIGGER_MAP: TriggerMap = {
  start: "Todo",
  resume: "Approved",
  pause: "Blocked",
  abort: "Canceled",
};

// --- Repo Config ---
// Each setup command is [command, ...args] to avoid shell parsing.
// Example: ["pnpm", "install", "--frozen-lockfile"]
const SetupCommandSchema = z.array(z.string()).min(1);
export type SetupCommand = z.infer<typeof SetupCommandSchema>;

const McpServerEntrySchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const PluginEntrySchema = z.object({
  type: z.literal("local"),
  path: z.string(),
});

export const PluginConfigSchema = z.object({
  /** Explicit MCP servers to always include */
  mcpServers: z.record(z.string(), McpServerEntrySchema).optional(),
  /** MCP server names to never include */
  excludeMcpServers: z.array(z.string()).optional(),
  /** Explicit plugins to always include */
  plugins: z.array(PluginEntrySchema).optional(),
  /** Plugin paths to never include */
  excludePlugins: z.array(z.string()).optional(),
  /** Set to false to disable auto-detection of plugins/MCP servers */
  autoDetect: z.boolean().optional(),
});
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

const DevcontainerConfigSchema = z.object({
  /** Enable devcontainer usage. Default: "auto" (use if .devcontainer exists) */
  mode: z.enum(["auto", "always", "never"]).optional(),
  /** Override path to devcontainer config */
  configPath: z.string().optional(),
  /** Extra environment variables for the container */
  env: z.record(z.string(), z.string()).optional(),
});
export type DevcontainerConfig = z.infer<typeof DevcontainerConfigSchema>;

const GitHubFeedbackConfigSchema = z.object({
  /**
   * GitHub logins allowed to trigger feedback runs.
   * If empty/omitted, any reviewer can trigger.
   */
  allowedReviewers: z.array(z.string()).optional(),
  /**
   * GitHub logins that should never trigger feedback runs (e.g. the bot itself).
   */
  botLogins: z.array(z.string()).optional(),
  /**
   * If provided, only comments containing this keyword trigger a feedback run.
   * When omitted and autoTrigger is true (the default), any qualifying comment triggers.
   * Example: "@agent fix this"
   */
  triggerKeyword: z.string().optional(),
  /**
   * If true (default), any qualifying review comment automatically triggers a feedback run.
   * Set to false to require the triggerKeyword to be present.
   */
  autoTrigger: z.boolean().optional(),
  /**
   * If true, re-request review on the PR after the feedback run pushes changes.
   * Requires GitHub App credentials in server config. Default: false.
   */
  rerequestReview: z.boolean().optional(),
});
export type GitHubFeedbackConfig = z.infer<typeof GitHubFeedbackConfigSchema>;

export const RepoConfigSchema = z.object({
  url: z.string(),
  defaultBranch: z.string(),
  testCommand: z.string(),
  buildCommand: z.string(),
  setupCommands: z.array(SetupCommandSchema).optional(),
  workingDirectory: z.string().optional(),
  plugins: PluginConfigSchema.optional(),
  devcontainer: DevcontainerConfigSchema.optional(),
  /** Per-team trigger map. Overrides the global triggerMap for this team's repo. Falls back to DEFAULT_TRIGGER_MAP. */
  triggerMap: TriggerMapSchema.optional(),
  /** Hosting provider. Defaults to "github". Set to "gitlab" for GitLab repos or "bitbucket" for Bitbucket. */
  provider: z.enum(["github", "gitlab", "bitbucket"]).optional(),
  /** Configuration for GitHub PR review comment → pipeline re-entry (feedback runs). */
  githubFeedback: GitHubFeedbackConfigSchema.optional(),
  /** BEC-135: Release Manager agent (Pro feature). */
  releaseManager: ReleaseManagerConfigSchema.optional(),
  /**
   * BEC-177: Label-based repo routing. When set, this repo is selected for pipeline runs
   * whose resolved pipeline label matches this pattern (case-insensitive exact match).
   * Takes priority over the teamId/projectId key lookup.
   *
   * Example: set `labelPattern: "observer-fix"` to route all Linear tickets with the
   * "observer-fix" pipeline label to this repo instead of the default repo.
   *
   * Backwards compatible: existing entries without `labelPattern` continue to be
   * resolved by their teamId/projectId key.
   */
  labelPattern: z.string().optional(),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

// --- Handoff Artifact ---
const TestResultSchema = z.object({
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  firstFailure: z.object({
    test: z.string(),
    error: z.string(),
    file: z.string(),
  }).optional(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const ReviewFindingSchema = z.object({
  severity: z.enum(["blocking", "warning", "suggestion"]),
  file: z.string(),
  line: z.number().int(),
  category: z.string(),
  description: z.string(),
  fix: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const HandoffArtifactSchema = z.object({
  runId: z.string(),
  issueId: z.string(),
  stage: z.string(),
  timestamp: z.string(),
  summary: z.string(),
  filesChanged: z.array(z.string()),
  approach: z.string(),
  context: z.object({
    issueIntent: z.string(),
    constraints: z.array(z.string()),
    assumptions: z.array(z.string()),
    testResults: TestResultSchema.optional(),
    reviewFindings: z.array(ReviewFindingSchema).optional(),
    addressedComments: z
      .array(
        z.object({
          commentId: z.string(),
          response: z.string(),
        }),
      )
      .optional(),
  }),
  tokenBudget: z.object({
    contextTokensUsed: z.number().int().min(0),
    recommendedMaxTurns: z.number().int().min(0),
  }),
});
export type HandoffArtifact = z.infer<typeof HandoffArtifactSchema>;

/**
 * BEC-227 Phase 4 / Track D. The implement agent emits this as a
 * `<decisions>{ JSON }</decisions>` XML block at the end of its turn.
 * Used by the review-fix loop's surgical prompt and by future Track F
 * cross-run inheritance. Every field is optional — malformed or missing
 * blocks degrade silently to an empty artifact.
 */
export const DecisionArtifactSchema = z.object({
  decisions: z.array(
    z.object({
      choice: z.string(),
      reason: z.string(),
      alternativesConsidered: z.array(z.string()).default([]),
    }),
  ).default([]),
  leftUnhandled: z.array(
    z.object({
      case: z.string(),
      reason: z.string(),
    }),
  ).default([]),
  keyFiles: z.array(z.string()).default([]),
});
export type DecisionArtifact = z.infer<typeof DecisionArtifactSchema>;

// --- Review Feedback Context ---
export const ReviewCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  file: z.string().optional(),
  line: z.number().int().optional(),
  diffHunk: z.string().optional(),
  createdAt: z.string(),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const ReviewFeedbackContextSchema = z.object({
  /** The URL of the PR being reviewed. */
  prUrl: z.string(),
  /** The branch to push fixes to (the existing PR branch). */
  prBranch: z.string(),
  /** Inline review comments with file/line context. */
  comments: z.array(ReviewCommentSchema),
  /** Optional overall review summary body (for full reviews, not just inline comments). */
  reviewBody: z.string().optional(),
  /** The original implement handoff, for context on what was done. */
  previousHandoff: HandoffArtifactSchema.optional(),
});
export type ReviewFeedbackContext = z.infer<typeof ReviewFeedbackContextSchema>;

// --- Merge Conflict Context ---
// Used when the push-queue rebase hits conflicts and we run the implement
// agent purely to resolve them. Routes the implement template into a focused
// "resolve conflicts and continue rebase" prompt instead of the standard
// "implement issue from scratch" path that confuses the agent into burning
// all 50 turns without making progress.
const MergeConflictContextSchema = z.object({
  /** The base branch name being rebased onto (e.g. "main"). */
  defaultBranch: z.string(),
});
export type MergeConflictContext = z.infer<typeof MergeConflictContextSchema>;

// --- Agent Profile ---
export interface AgentProfile {
  tools: string[];
  maxInputTokens: number;
  maxTurns: number;
  model?: string; // Anthropic model ID, e.g. "claude-sonnet-4-6" or "claude-opus-4-6"
}

export interface TokenBudget {
  maxInputTokens: number;
  maxTurns: number;
}

// --- Run Status ---
export type PipelineRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "paused"
  /** Operator-initiated stop (cancel/graceful via dashboard, Slack, or CLI).
   *  Distinct from "aborted" (system-initiated, e.g. token budget). */
  | "cancelled";
export type StageRunStatus = "running" | "completed" | "failed" | "skipped" | "cancelled";
export type AgentLogType = "tool_call" | "tool_result" | "message" | "error" | "cancelled";

// --- Sanitized Issue ---
export const SanitizedIssueSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  labels: z.array(z.string()),
  priority: z.number(),
});
export type SanitizedIssue = z.infer<typeof SanitizedIssueSchema>;

// --- Resume Payload ---
// Snapshot of all context needed to restart a paused or retriable pipeline run.
// Stored as JSON in pipeline_runs.resume_payload; validated with safeParse on
// resume so schema mismatches from older DB rows fail gracefully (run → failed).
// Note: currentStageIndex may be -1 for transient-failure retries (stage 0 failed;
// slice(-1+1) = slice(0) re-runs the full stage list from the start).
export const ResumePayloadSchema = z.object({
  worktreePath: z.string(),
  currentStageIndex: z.number().int(),
  handoff: HandoffArtifactSchema.nullable(),
  pipelineConfig: PipelineConfigSchema,
  repoConfig: RepoConfigSchema,
  sanitizedIssue: SanitizedIssueSchema,
});
export type ResumePayload = z.infer<typeof ResumePayloadSchema>;

// --- Stage Result ---
export interface StageResult {
  status: "completed" | "failed" | "cancelled";
  handoffArtifact?: HandoffArtifact;
  /** True when the agent produced a valid structured handoff JSON block.
   *  NOTE: not persisted to DB yet — runtime-only. Add a column if needed for dashboards/queries. */
  handoffIsStructured?: boolean;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  errorMessage?: string;
  /** ID of the `stage_runs` row created for this execution. Used by callers that
   *  need to associate per-stage artifacts (e.g. `review_model_runs`) with the
   *  same row the executor inserted. Always populated by `executeStage`. */
  stageRunId: string;
}

// --- Pipeline Run ---
export interface PipelineRun {
  id: string;
  issueId: string;
  issueTitle: string;
  pipelineKey: string;
  repoUrl: string;
  branch: string | null;
  status: PipelineRunStatus;
  startedAt: Date;
  completedAt?: Date;
  prUrl?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** True when the pipeline auto-merged the PR. Persisted to DB. */
  autoMerged?: boolean;
  /** Reason for the auto-merge decision (success reason or skip reason). Persisted to DB. */
  autoMergeReason?: string;
  /** True when auto-commit was triggered because the agent did not commit its work. Quality metric. */
  autoCommitted?: boolean;
  /**
   * In-memory only: count of retries per stage. Surfaces silent retry attempts
   * in the "pipeline completed" log when non-zero.
   *
   * TODO(urateam#121): persist to DB so the dashboard can show retry counts on
   * completed runs, and so transient-retry resumes (which reload the run from
   * DB) carry the count forward.
   */
  stageRetries?: Record<string, number>;
  /**
   * The type of run: "standard" for normal issue pipelines, "review-feedback"
   * for runs triggered by PR review comments. Mirrors the DB `run_type` column.
   * Used to skip RALPH for review-feedback runs (BEC-182).
   */
  runType?: string | null;
  /**
   * JSON-serialised `ReviewFeedbackComment[]` captured at run start. Mirrors
   * the DB `feedback_context` column. Used by the PR change-summary dispatcher
   * to reconstruct the triggering review comments.
   */
  feedbackContext?: string | null;
}

// --- Pipeline Result / Error ---
export interface PipelineResult {
  prUrl: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  stagesCompleted: number;
  autoMerged?: boolean;
}

export interface PipelineError {
  stage: string;
  message: string;
  retriesExhausted: boolean;
}

// --- Token Budget ---
export interface DailyTokenSummary {
  date: string; // ISO date string, e.g. "2026-03-31"
  totalInputTokens: number;
  totalOutputTokens: number;
  runsCompleted: number;
  runsFailed: number;
}

// --- Notifier Interface ---
export interface Notifier {
  onPipelineStart(run: PipelineRun): Promise<void>;
  onStageComplete(run: PipelineRun, stage: string, result: StageResult): Promise<void>;
  onPipelineComplete(run: PipelineRun, result: PipelineResult): Promise<void>;
  onPipelineFailed(run: PipelineRun, error: PipelineError): Promise<void>;
  /** Called when a PR needs human review (not auto-merged). */
  onHumanReviewNeeded?(run: PipelineRun, prUrl: string, reason: string): Promise<void>;
  /** Called once when token usage reaches 80% of maxTokens. */
  onTokenBudgetAlert?(run: PipelineRun, usedTokens: number, maxTokens: number): Promise<void>;
  /** Called by sendDailyTokenSummary() with aggregated usage for a given date. */
  onDailyTokenSummary?(summary: DailyTokenSummary): Promise<void>;
  /**
   * BEC-186: called when a GitHub pull_request.closed webhook arrives with
   * merged=true — either from a human merge via the GitHub UI or from
   * GitHub's "auto-merge when ready" feature — after the pipeline has already
   * completed. Transitions the Linear issue to Done and posts a "PR merged"
   * comment.
   */
  onPRMerged?(run: PipelineRun): Promise<void>;
}

// --- Sandbox Config ---
export interface SandboxConfig {
  workdir: string;
  allowedDomains: string[];
  denyRead: string[];
  denyWrite: string[];
}

// --- Audit Log ---
export const AuditEventTypeSchema = z.enum([
  "run.started", "run.completed", "run.failed",
  "run.auto_merged", "run.auto_merge_skipped",
  /** Operator-initiated stop of a single run (mode: "cancel" | "graceful"). */
  "run.cancelled",
  /** Operator-initiated container-wide halt (pause PM + cancel all in-flight). */
  "system.halted",
  "pm.approval_requested", "pm.approval_resolved",
  "pm.issue_promoted", "pm.issue_deprioritized", "pm.issue_cancelled",
  "pm.triage_classified",
  /** Tier 6e — emitted after each successful push. Compares triage v2's
   *  `affectedFiles` prediction against the actual diff to track prediction
   *  quality over time. When `hasV2Prediction` is false the triage stage
   *  ran v1 (no prediction) and only `actual` / `runId` / `issueId` are
   *  meaningful. */
  "pm.triage_quality_score",
  "pm.agent_branch_swept",
  "pm.skipped_circuit_breaker",
  "pm.recovered_long_running",
  "budget.alert_fired", "budget.run_refused",
  "license.validation_failed", "config.loaded",
  /** Claude CLI session credentials have expired (BEC-207). Operational
   *  signal: new pipeline runs will fail immediately until `claude login`
   *  is re-run or CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY is configured. */
  "claude.auth_expired",
  "dashboard.manual_action",
  "dashboard.login", "dashboard.logout", "dashboard.login_denied",
  "policy.path_blocked", "policy.cost_exceeded",
  "policy.override_used", "policy.reviewers_requested",
  "release.fired", "release.skipped", "release.approved",
  "release.tag_conflict", "release.partial",
  "slack.post_failed",
  "qa.run_triggered", "qa.run_completed", "qa.gap_issue_filed",
  "review.fanout_fallback_used", "review.model_low_output_ratio",
  /** Tier 1a — the scratch-file denylist gate fired on this run, forcing a
   *  draft PR. Payload includes the matched paths. */
  "pipeline.scratch_files_blocked",
  /** Tier 1b — `pnpm typecheck` (or the configured equivalent) reported
   *  errors on the agent's diff before push. Payload includes errorCount and
   *  up to 5 first messages. The runner forces draft and surfaces the output
   *  in the PR body. */
  "pipeline.typecheck_failed",
  /** Tier 1c — the spec-vs-impl JSDoc gate found one or more docblock
   *  references to `config.X` / `opts.X` / etc. that aren't defined anywhere
   *  in the worktree. Payload lists matched (file, prefix, symbol) tuples
   *  (capped at 20). */
  "pipeline.spec_vs_impl_failed",
  /** Tier 3 — auto-deep-review thresholds tripped on this run; the runner
   *  bumped `deepReviewPasses` from its configured value to ≥1 so the
   *  deep-review fanout runs. Payload includes the diff metrics and which
   *  threshold tripped. */
  "pipeline.auto_deep_review_bumped",
  /** Tier 5 — an issue tripped the consecutive-failures circuit breaker
   *  (≥ `maxConsecutiveFailures` failed runs in a row). The PM Agent
   *  escalated by adding the `needs-design` label, posting a Linear
   *  comment with the last failure's error message, and sending a Slack
   *  alert. Payload includes failureCount and a truncated errorMessage. */
  "pm.escalated_to_needs_design",
  /** BEC-236 — PM tick selected this issue for a half-open circuit-breaker probe.
   *  The breaker is currently engaged (≥ maxConsecutiveFailures), but the
   *  cooldown window has elapsed and the per-tick probe cap allows it through.
   *  Payload: issueId, consecutiveFailures, lastProbeAgeMin (minutes since the
   *  previous probe; -1 for the first probe — NOT the age since the last
   *  failure), probeAttempts. */
  "pm.circuit_breaker_probe",
  /** BEC-236 — A probe run reached terminal `completed` status, so the
   *  circuit_breaker_state row was deleted and the Tier-5-added `needs-design`
   *  label was removed. Payload: issueId, probeAttempts. */
  "pm.circuit_breaker_recovered",
  /** BEC-236 — `ura circuit reset` cleared the breaker for an issue. Payload:
   *  issueId, scope ("single" | "bulk"), failedRunsDeleted (count of
   *  pipeline_runs rows the reset deleted). */
  "pm.circuit_breaker_reset_manual",
  /** BEC-253 — `ura tick` invoked a PM tick on demand via the CLI. Payload:
   *  actor (cli:<os-user>), durationMs (wall-clock time for the tick),
   *  errors (string array, empty when tick succeeded without exceptions). */
  "pm.manual_tick_invoked",
  /** `ura service install` succeeded — a launchd plist (macOS) or systemd-user
   *  unit (Linux) was written and the service was started. Operational signal
   *  so operators can audit unattended provisioning. */
  "service.installed",
  /** `ura service uninstall` succeeded — the unit file was removed and the
   *  service stopped. */
  "service.uninstalled",
  /** `ura self-auth-linear` completed: the operator authorized urateam in
   *  Linear and the CLI persisted the access token to `~/.urateam/.env` as
   *  `LINEAR_API_KEY`. Payload includes the Linear workspace ID (never the
   *  token itself). */
  "linear.oauth_completed",
  /** `ura start --tunnel <mode>` brought a public tunnel up; the daemon
   *  now has a reachable URL. Payload: provider, publicUrl, restartCount. */
  "tunnel.started",
  /** The tunnel child process exited — either gracefully (operator stopped
   *  the daemon) or because the restart cap was hit. Payload: provider,
   *  restartCount, exitCode, signal. */
  "tunnel.stopped",
  /** `ura start` reloaded `~/.urateam/config.json` without restart. Payload
   *  carries added / removed / modifiedSafe / modifiedUnsafe arrays + diff
   *  hash, so operators can audit which repos came/went without grepping
   *  the daemon log. */
  "config.reloaded",
  /** BEC-227 — a fresh per-run Agent SDK session was created on the first
   *  resumable stage. Payload: runId, issueId, sessionId (UUID generated
   *  by the SDK on the first `query()` call). */
  "pipeline.agent_session_created",
  /** BEC-227 — a downstream stage resumed the per-run Agent SDK session via
   *  `query({ resume: sessionId })`. Payload includes the stage name and
   *  the prior message count read from the session JSONL transcript so
   *  operators can see how much context was inherited. */
  "pipeline.agent_session_resumed",
  /** BEC-227 — a stage attempted to resume the per-run session but the
   *  underlying JSONL transcript was missing, unreadable, or the SDK
   *  rejected the resume. The runner fell back to a fresh session for
   *  this stage. Payload `reason` carries the failure mode. */
  "pipeline.agent_session_missing_fallback",
  /** BEC-227 — at boot, the session-volume check found `~/.claude/projects`
   *  on tmpfs, missing, or unwritable — meaning session JSONLs won't
   *  survive container restarts. Payload carries the projectsDir path and
   *  the failure reason so operators can fix their mount config. */
  "system.session_volume_warning",
  /** BEC-227 Phase 4 / Track B — the review-fix loop took the surgical path:
   *  it resumed the per-run Agent SDK session and prompted the agent with
   *  just the blocking review findings (plus the previously-persisted
   *  decision artifact when available), instead of re-running the full
   *  implement template. Payload: `runId`, `issueId`, `path` ("surgical" |
   *  "legacy"), `findingsCount`, `decisionPayloadBytes` (0 when no
   *  artifact was found). The `legacy` path is logged too so operators
   *  can audit fallback rates. */
  "pipeline.surgical_review_fix",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditActorTypeSchema = z.enum([
  "system", "pm-agent", "webhook", "dashboard-user", "cli",
  "release-manager",
  /** Slack-initiated action (slash command or DM/@mention). */
  "slack",
]);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditEventSchema = z.object({
  id: z.string(),
  timestamp: z.date(),
  eventType: AuditEventTypeSchema,
  actor: z.string(),
  actorType: AuditActorTypeSchema,
  scope: z.string().nullable(),
  runId: z.string().nullable(),
  issueId: z.string().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// --- Cost / ROI ---
export const ModelPricingSchema = z.object({
  inputPerMillion: z.number().positive(),
  outputPerMillion: z.number().positive(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const CostsConfigSchema = z.object({
  modelPricing: z.record(z.string(), ModelPricingSchema).default({
    "claude-opus-4-6":   { inputPerMillion: 15, outputPerMillion: 75 },
    "claude-sonnet-4-6": { inputPerMillion:  3, outputPerMillion: 15 },
    "claude-haiku-4-5":  { inputPerMillion:  1, outputPerMillion:  5 },
  }),
  hourlyEngRate: z.number().positive().default(50),
  timeSavedPerPrDefault: z.number().positive().default(4),
});
export type CostsConfig = z.infer<typeof CostsConfigSchema>;

/**
 * Top-level application config schema. Currently only scopes the audit log
 * section introduced with the audit-log feature; additional sections can be
 * added here as the rest of the config is migrated to zod.
 */
export const SsoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workosApiKey: z.string().min(1),
  workosClientId: z.string().min(1),
  redirectUri: z.string().url(),
  allowedDomain: z.string().optional(),
  sessionDurationHours: z.number().int().positive().default(24),
  cookieName: z.string().default("urateam_session"),
  cookieSecure: z.boolean().default(true),
  stateSigningSecret: z.string().min(16),
});
export type SsoConfig = z.infer<typeof SsoConfigSchema>;

export const AppConfigSchema = z.object({
  auditLog: z.object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().positive().optional().default(365),
  }).optional(),
  sso: SsoConfigSchema.optional(),
  costs: CostsConfigSchema.optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
