import { z } from "zod";

export const PmAgentConfigSchema = z.object({
  enabled: z.boolean(),
  cronIntervalMs: z.number().int().positive().default(1_800_000),
  maxInFlight: z.number().int().min(1).default(3),
  triageBatchSize: z.number().int().min(1).default(3),
  dailyTokenBudget: z.number().int().positive(),
  slackChannelId: z.string().min(1),
  teamIds: z.array(z.string().min(1)).min(1),
  /** Enable auto-recovery of Linear issues stuck in "In Progress" with no active pipeline run. */
  stuckIssueRecovery: z.boolean().default(true),
  /** Target Linear state for recovered stuck issues. Defaults to "Backlog" for re-triage. */
  stuckIssueTargetState: z.enum(["Backlog", "Todo"]).default("Backlog"),
  /** Max number of stuck issues to recover per PM Agent tick (rate limiter). */
  stuckIssueMaxPerTick: z.number().int().min(1).default(5),
  budgets: z
    .object({
      /** Default daily token budget for any team or repo not explicitly listed. Falls back to top-level dailyTokenBudget if omitted. */
      default: z.number().int().positive().optional(),
      /** Per-team daily token budget, keyed by Linear team ID. Overrides default for that team. */
      perTeam: z.record(z.string().min(1), z.number().int().positive()).optional(),
      /** Per-repo daily token budget, keyed by full repo URL. Overrides default for that repo. */
      perRepo: z.record(z.string().min(1), z.number().int().positive()).optional(),
      /** Slack channel for budget alerts. Defaults to the PM Agent's slackChannelId. */
      alertChannel: z.string().min(1).optional(),
    })
    .optional(),
});
export type PmAgentConfig = z.infer<typeof PmAgentConfigSchema>;

export interface BudgetGuardResult {
  promoteBlocked: boolean;
  reason?: string;
  activeCount: number;
  tokenSpendPercent: number;
  dailyTokensUsed: number;
}

export type BudgetTier = "ok" | "warn-50" | "warn-80" | "blocked-100";

export type BudgetScope =
  | { kind: "global" }
  | { kind: "team"; teamId: string }
  | { kind: "repo"; repoUrl: string };

export interface ScopeBudget {
  scope: BudgetScope;
  /** Human-readable label: "global" | "team <id>" | "repo <short-name>". Used in Slack messages and log lines. */
  scopeLabel: string;
  limit: number;
  used: number;
  percent: number;
  tier: BudgetTier;
}

export interface BudgetEvaluation {
  scopes: ScopeBudget[];
  worstTier: BudgetTier;
  /** True iff any scope is at tier 'blocked-100'. */
  promoteBlocked: boolean;
  /** Human-readable reason for a block, naming the first blocking scope. Undefined when not blocked. */
  blockReason?: string;
  activeCount: number;
}

export interface TriageResult {
  issueId: string;
  priority: number;
  labels: string[];
  complexity: "trivial" | "small" | "medium" | "large";
  rationale: string;
  acceptanceCriteria: string[];
}

export interface ConflictCheckResult {
  overlapRisk: "none" | "low" | "high";
  likelyFiles: string[];
  reasoning: string;
}

export interface PromoteResult {
  issueId: string;
  issueTitle: string;
  promoted: boolean;
  reason: string;
  overlapRisk?: "none" | "low" | "high";
}

export interface TickResult {
  triaged: TriageResult[];
  promoted: PromoteResult[];
  approvalsResolved: number;
  approvalsPending: number;
  deprioritizeRequested: string[];
  cancelRequested: string[];
  errors: string[];
  budgetGuard: BudgetGuardResult;
  /** True when the PM Agent is paused — promote/deprioritize/cancel were skipped. */
  paused?: boolean;
  /** Issue identifiers auto-recovered from stuck "In Progress" state. */
  recoveredStuckIssues?: string[];
  /** Todo issues that were started by the tick (orphaned from webhook). */
  startedTodoIssues?: Array<{ identifier: string; started: boolean; reason: string }>;
}

export type ApprovalAction = "deprioritize" | "cancel";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRecord {
  id: string;
  issueId: string;
  action: ApprovalAction;
  reason: string;
  slackMessageTs: string;
  status: ApprovalStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}
