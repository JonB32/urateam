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
  turns: integer("turns").notNull().default(0),
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
