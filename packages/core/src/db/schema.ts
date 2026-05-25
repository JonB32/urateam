import { customType, sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";

/**
 * Active driver mode for cross-database timestamp serialization.
 * Set by createDb when a connection is established.
 * Internal — not part of the public API.
 */
export let _schemaDriver: "sqlite" | "postgres" = "sqlite";

/** @internal — called only by createDb in client.ts. */
export function _setSchemaDriver(driver: "sqlite" | "postgres"): void {
  _schemaDriver = driver;
}

/**
 * Cross-database timestamp column type.
 *
 * - SQLite:   stored as INTEGER epoch seconds. `toDriver` converts Date → epoch int.
 *             `fromDriver` converts epoch integer (or legacy ISO string) → Date.
 * - Postgres: stored as TIMESTAMPTZ. `toDriver` converts Date → ISO-8601 string.
 *             `fromDriver` converts the Date object returned by postgres-js → Date.
 *
 * Application code always works with plain JS `Date` objects regardless of driver.
 */
export const crossTimestamp = customType<{
  data: Date;
  driverData: number | string | Date;
}>({
  dataType() {
    return _schemaDriver === "postgres" ? "timestamptz" : "integer";
  },
  toDriver(value: Date): number | string {
    if (_schemaDriver === "postgres") {
      return value.toISOString();
    }
    return Math.floor(value.getTime() / 1000);
  },
  fromDriver(value: number | string | Date): Date {
    if (value instanceof Date) return value;
    if (typeof value === "number") return new Date(value * 1000);
    return new Date(value as string);
  },
});

export const pipelineRuns = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull(),
  issueTitle: text("issue_title").notNull(),
  pipelineKey: text("pipeline_key").notNull(),
  repoUrl: text("repo_url").notNull(),
  /** BEC-227 — Claude Agent SDK session UUID; null = legacy/flag-off, populated = SDK session UUID for resumption. */
  agentSessionId: text("agent_session_id"),
  branch: text("branch"),
  status: text("status").notNull(),
  startedAt: crossTimestamp("started_at")
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: crossTimestamp("completed_at"),
  prUrl: text("pr_url"),
  totalInputTokens: integer("total_input_tokens").notNull().default(0),
  totalOutputTokens: integer("total_output_tokens").notNull().default(0),
  errorMessage: text("error_message"),
  currentStageIndex: integer("current_stage_index"),
  resumePayload: text("resume_payload"),
  retryCount: integer("retry_count").notNull().default(0),
  /** "standard" for normal runs, "review-feedback" for PR comment re-entry runs. */
  runType: text("run_type").notNull().default("standard"),
  /** For review-feedback runs: the run ID of the original pipeline run that created the PR. */
  parentRunId: text("parent_run_id"),
  /** For review-feedback runs: JSON-serialised array of ReviewFeedbackComment objects. */
  feedbackContext: text("feedback_context"),
  /** True (1) when the pipeline auto-merged the PR; false (0) otherwise. */
  autoMerged: integer("auto_merged", { mode: "boolean" }),
  /** Human-readable reason for the auto-merge decision (e.g. "PR auto-merged" or skip reason). */
  autoMergeReason: text("auto_merge_reason"),
  /** True (1) when auto-commit was triggered because the agent did not commit its work. Quality metric. */
  autoCommitted: integer("auto_committed", { mode: "boolean" }),
  /** Linear team ID from the webhook payload. Nullable for legacy rows created before per-team budget scoping. */
  linearTeamId: text("linear_team_id"),
});

export const stageRuns = sqliteTable("stage_runs", {
  id: text("id").primaryKey(),
  pipelineRunId: text("pipeline_run_id")
    .notNull()
    .references(() => pipelineRuns.id),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  startedAt: crossTimestamp("started_at")
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: crossTimestamp("completed_at"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
  cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
  turns: integer("turns").notNull().default(0),
  /** Timestamp of the last progress update during stage execution. Updated
   *  periodically by the executor's onProgress/onToolMessage callbacks.
   *  Used by detectStageHang() to identify stuck implement stages. */
  lastProgressAt: crossTimestamp("last_progress_at"),
  handoffArtifact: text("handoff_artifact"),
  errorMessage: text("error_message"),
});

export const agentLogs = sqliteTable("agent_logs", {
  id: text("id").primaryKey(),
  stageRunId: text("stage_run_id")
    .notNull()
    .references(() => stageRuns.id),
  timestamp: crossTimestamp("timestamp")
    .notNull()
    .$defaultFn(() => new Date()),
  type: text("type").notNull(),
  content: text("content").notNull(),
});

export const activeWork = sqliteTable("active_work", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  issueId: text("issue_id").notNull(),
  stage: text("stage").notNull(),
  filesModified: text("files_modified"),
  startedAt: crossTimestamp("started_at")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: crossTimestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const webhookDedup = sqliteTable("webhook_dedup", {
  id: text("id").primaryKey(),
  expiresAt: crossTimestamp("expires_at").notNull(),
});

/**
 * BEC-236 — tracks Tier-5 circuit-breaker escalations so the half-open
 * probe can distinguish them from human/triage-added `needs-design`
 * labels. Insert on Tier-5 escalation (idempotent via the issue_id PK),
 * update last_probe_at + probe_attempts in selectProbeCandidates, delete
 * on probe-recovery or manual reset.
 */
export const circuitBreakerState = sqliteTable("circuit_breaker_state", {
  issueId: text("issue_id").primaryKey(),
  escalatedAt: crossTimestamp("escalated_at")
    .notNull()
    .$defaultFn(() => new Date()),
  lastProbeAt: crossTimestamp("last_probe_at"),
  probeAttempts: integer("probe_attempts").notNull().default(0),
});

export const triageResults = sqliteTable("triage_results", {
  issueId: text("issue_id").primaryKey(),
  v2Prediction: text("v2_prediction").notNull().default("{}"),
  triagedAt: crossTimestamp("triaged_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const pmApprovals = sqliteTable("pm_approvals", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  slackMessageTs: text("slack_message_ts").notNull(),
  status: text("status").notNull(),
  createdAt: crossTimestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: crossTimestamp("resolved_at"),
});

/**
 * BEC-227 Phase 4 / Track D. Persists the `<decisions>` JSON block emitted
 * by the implement agent at the end of each implement turn. Multiple rows
 * per pipeline_run when RALPH iterates (one per (iteration, stage)).
 */
export const pipelineRunDecisions = sqliteTable("pipeline_run_decisions", {
  id: text("id").primaryKey(),
  pipelineRunId: text("pipeline_run_id").notNull().references(() => pipelineRuns.id),
  iteration: integer("iteration").notNull(),
  stage: text("stage").notNull(),
  payload: text("payload").notNull(),
  createdAt: crossTimestamp("created_at").notNull(),
});

export type PipelineRunDecisionRow = typeof pipelineRunDecisions.$inferSelect;

/**
 * Dedup table for budget threshold alerts. One row per (date, scope, threshold)
 * — the UNIQUE constraint + onConflictDoNothing() guarantees an alert fires at
 * most once per day per scope per threshold.
 */
export const budgetAlerts = sqliteTable(
  "budget_alerts",
  {
    id: text("id").primaryKey(),
    /** UTC date the alert covers, formatted 'YYYY-MM-DD'. */
    date: text("date").notNull(),
    /** 'global' | 'team:<linearTeamId>' | 'repo:<repoUrl>'. */
    scope: text("scope").notNull(),
    /** 50 | 80 | 100. */
    threshold: integer("threshold").notNull(),
    firedAt: crossTimestamp("fired_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique().on(t.date, t.scope, t.threshold),
  ],
);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  timestamp: crossTimestamp("timestamp")
    .notNull()
    .$defaultFn(() => new Date()),
  eventType: text("event_type").notNull(),
  actor: text("actor").notNull(),
  actorType: text("actor_type").notNull(),
  scope: text("scope"),
  runId: text("run_id"),
  issueId: text("issue_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  payload: text("payload").notNull().default("{}"),
});

export const dashboardUsers = sqliteTable("dashboard_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  workosUserId: text("workos_user_id"),
  createdAt: crossTimestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  lastLoginAt: crossTimestamp("last_login_at"),
  role: text("role").notNull().default("viewer"),
});

export const dashboardSessions = sqliteTable("dashboard_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => dashboardUsers.id),
  createdAt: crossTimestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: crossTimestamp("expires_at").notNull(),
  lastSeenAt: crossTimestamp("last_seen_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Enterprise feature 4.5: pre-aggregated daily cost rollups for the /cost dashboard. */
export const costRollupsDaily = sqliteTable("cost_rollups_daily", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  pipelineKey: text("pipeline_key").notNull(),
  linearTeamId: text("linear_team_id"),
  repoUrl: text("repo_url").notNull(),
  runs: integer("runs").notNull().default(0),
  prsMerged: integer("prs_merged").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  dollars: real("dollars").notNull().default(0),
  timeSavedHours: real("time_saved_hours").notNull().default(0),
  computedAt: crossTimestamp("computed_at")
    .notNull()
    .$defaultFn(() => new Date()),
}, (t) => [
  unique().on(t.date, t.pipelineKey, t.linearTeamId, t.repoUrl),
]);

/** BEC-134: per-model results from review-stage fanout. */
export const reviewModelRuns = sqliteTable("review_model_runs", {
  id: text("id").primaryKey(),
  stageRunId: text("stage_run_id")
    .notNull()
    .references(() => stageRuns.id),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  status: text("status").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  errorMessage: text("error_message"),
  truncatedFiles: integer("truncated_files").notNull().default(0),
  startedAt: crossTimestamp("started_at"),
  completedAt: crossTimestamp("completed_at"),
});

/** BEC-135: cron decisions logged each tick — one row per fire OR skip. */
export const releaseDecisions = sqliteTable("release_decisions", {
  id: text("id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull(),
  decidedAt: crossTimestamp("decided_at")
    .notNull()
    .$defaultFn(() => new Date()),
  /** "fire" | "skip" | "awaiting-approval" | "fire-pending" */
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  /** JSON snapshot of trigger inputs at decision time, for debugging. */
  triggerStateJson: text("trigger_state_json").notNull(),
  proposedVersion: text("proposed_version"),
  firedTag: text("fired_tag"),
  firedSha: text("fired_sha"),
  /** Tracks retries when GitHub release-creation fails after tag was created. Capped at 3. */
  attemptCount: integer("attempt_count").notNull().default(0),
  /** BEC-136: GitHub workflow run ID for the in-flight QA run. Null when no QA in flight. */
  qaRunId: integer("qa_run_id"),
  /** BEC-136: SHA the QA workflow was triggered against. Used to detect mid-run SHA mismatch. */
  qaRunSha: text("qa_run_sha"),
});

/** BEC-135: one-shot Slack-driven approvals consumed by the next eligible fire. */
export const releaseApprovals = sqliteTable(
  "release_approvals",
  {
    id: text("id").primaryKey(),
    repoUrl: text("repo_url").notNull(),
    branch: text("branch").notNull(),
    approvedAt: crossTimestamp("approved_at")
      .notNull()
      .$defaultFn(() => new Date()),
    /** Slack user ID (e.g. "U12345"). */
    approvedBy: text("approved_by").notNull(),
    consumedAt: crossTimestamp("consumed_at"),
    consumedByDecisionId: text("consumed_by_decision_id"),
  },
  // The UNIQUE WHERE consumed_at IS NULL partial index is created in the
  // raw migration SQL because Drizzle's sqliteTable.unique() helper does
  // not support partial indexes. Migration files own that concern.
);

/** BEC-136: tracks Linear issues filed for missing QA workflows — partial UNIQUE prevents re-filing while open. */
export const qaGapIssues = sqliteTable(
  "qa_gap_issues",
  {
    id: text("id").primaryKey(),
    repoUrl: text("repo_url").notNull(),
    branch: text("branch").notNull(),
    workflowPath: text("workflow_path").notNull(),
    /** Linear issue identifier returned at file time (e.g., "BEC-150"). */
    linearIssueId: text("linear_issue_id").notNull(),
    filedAt: crossTimestamp("filed_at")
      .notNull()
      .$defaultFn(() => new Date()),
    /** Set when the gap is detected as resolved (workflow file appears). Issue itself is closed manually by operator. */
    resolvedAt: crossTimestamp("resolved_at"),
  },
  // The UNIQUE WHERE resolved_at IS NULL partial index is created in the
  // raw migration SQL because Drizzle's sqliteTable.unique() helper does
  // not support partial indexes. Migration files own that concern.
);
