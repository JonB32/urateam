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
});
export type PmAgentConfig = z.infer<typeof PmAgentConfigSchema>;

export interface BudgetGuardResult {
  promoteBlocked: boolean;
  reason?: string;
  activeCount: number;
  tokenSpendPercent: number;
  dailyTokensUsed: number;
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
