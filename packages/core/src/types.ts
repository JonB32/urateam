import { z } from "zod";
import { ReleaseManagerConfigSchema } from "./release-manager/types.js";

// --- Stage Types ---
export const StageTypeSchema = z.enum([
  "triage", "await-approval", "reproduce", "implement", "test", "review",
]);
export type StageType = z.infer<typeof StageTypeSchema>;

export const AGENT_STAGES: StageType[] = [
  "triage", "reproduce", "implement", "test", "review",
];

// --- Pipeline Config ---
export const RetryStrategySchema = z.enum(["fix-and-retry", "escalate", "fail-fast"]);
export type RetryStrategy = z.infer<typeof RetryStrategySchema>;

export const RetryConfigSchema = z.object({
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
   *  Set to 1 to opt in for critical pipelines (adds ~45-100K tokens per pass). */
  deepReviewPasses: z.number().int().min(0).max(5).optional(),
  /** Hard cap on deep review passes. Prevents infinite loops. Default: 3. */
  maxDeepReviewPasses: z.number().int().min(1).max(10).optional(),
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
export const SetupCommandSchema = z.array(z.string()).min(1);
export type SetupCommand = z.infer<typeof SetupCommandSchema>;

export const McpServerEntrySchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const PluginEntrySchema = z.object({
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

export const DevcontainerConfigSchema = z.object({
  /** Enable devcontainer usage. Default: "auto" (use if .devcontainer exists) */
  mode: z.enum(["auto", "always", "never"]).optional(),
  /** Override path to devcontainer config */
  configPath: z.string().optional(),
  /** Extra environment variables for the container */
  env: z.record(z.string(), z.string()).optional(),
});
export type DevcontainerConfig = z.infer<typeof DevcontainerConfigSchema>;

export const GitHubFeedbackConfigSchema = z.object({
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
  /** Hosting provider. Defaults to "github". Set to "gitlab" for GitLab repos. */
  provider: z.enum(["github", "gitlab"]).optional(),
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
export const TestResultSchema = z.object({
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
export const MergeConflictContextSchema = z.object({
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
export type PipelineRunStatus = "queued" | "running" | "completed" | "failed" | "aborted" | "paused";
export type StageRunStatus = "running" | "completed" | "failed" | "skipped";
export type AgentLogType = "tool_call" | "tool_result" | "message" | "error";

// --- Sanitized Issue ---
export interface SanitizedIssue {
  id: string;
  slug: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  labels: string[];
  priority: number;
}

// --- Stage Result ---
export interface StageResult {
  status: "completed" | "failed";
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
  "pm.approval_requested", "pm.approval_resolved",
  "pm.issue_promoted", "pm.issue_deprioritized", "pm.issue_cancelled",
  "pm.triage_classified",
  "pm.agent_branch_swept",
  "pm.skipped_circuit_breaker",
  "pm.recovered_long_running",
  "budget.alert_fired", "budget.run_refused",
  "license.validation_failed", "config.loaded",
  "dashboard.manual_action",
  "dashboard.login", "dashboard.logout", "dashboard.login_denied",
  "policy.path_blocked", "policy.cost_exceeded",
  "policy.override_used", "policy.reviewers_requested",
  "release.fired", "release.skipped", "release.approved",
  "release.tag_conflict", "release.partial",
  "slack.post_failed",
  "qa.run_triggered", "qa.run_completed", "qa.gap_issue_filed",
  "review.fanout_fallback_used", "review.model_low_output_ratio",
  "claude.auth_expired",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditActorTypeSchema = z.enum([
  "system", "pm-agent", "webhook", "dashboard-user", "cli",
  "release-manager",
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
