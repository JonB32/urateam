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
  /**
   * BEC-150: when true, the `promote` step only promotes Backlog issues whose
   * labels resolve to a configured pipeline. Default false for back-compat;
   * set via PM_AGENT_REQUIRE_PIPELINE_LABEL_FOR_PROMOTE=true.
   */
  requirePipelineLabelForPromote: z.boolean().default(false),
  /**
   * BEC-161: when set, promote and start-todo skip issues with this many or
   * more consecutive failed pipeline runs (since the last successful run).
   * Set via PM_AGENT_MAX_CONSECUTIVE_FAILURES (default 3, 0 disables).
   */
  maxConsecutiveFailures: z.number().int().min(0).default(3),
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
  /** Tier 4 — 3-5 line approach summary the agent will follow. Empty for
   *  observer-origin issues (which skip Claude classification). */
  approachSummary?: string;
  /** Tier 4 — questions the operator must answer before implement starts.
   *  When non-empty, the pipeline is forced to `needs-design` regardless of
   *  the complexity classification, mirroring the observer-marker gate. */
  openQuestions?: string[];
  /** Tier 4 — "things this should NOT do" — anti-acceptance criteria the
   *  agent must respect to stay in scope. */
  antiAcceptanceCriteria?: string[];
  /** Tier 6b — assumptions the agent will take for granted. Operator-
   *  correctable via the Linear comment before implement burns tokens.
   *  Max 10. */
  assumptions?: string[];
  /** Tier 6b — concrete input/output pairs that ground the implement
   *  agent's generation. Max 3. */
  examples?: Array<{ scenario: string; expected: string }>;
  /** Tier 6b — best-guess paths the implementation will touch. Compared
   *  against the actual diff at review time as a quality signal (Tier 6e
   *  consumer). Max 20. */
  affectedFiles?: string[];
  /** Tier 6b — which test file(s) the implement agent should start from
   *  and what shape of assertions to write. */
  testStrategy?: { unit?: string; integration?: string };
  /** Tier 6b — severity classification + the subsystems triage thinks
   *  the change touches. Feeds the cost gate and the auto-deep-review
   *  default. `areas` max 5. */
  riskAssessment?: {
    severity: "low" | "medium" | "high";
    areas: string[];
  };
}

// ---------------------------------------------------------------------------
// Tier 6b — TriageV2 extensions: zod schema + tolerant parser.
//
// The schema is `.optional()` per FR-003 so a partial Haiku response still
// produces a valid v1-shaped TriageResult. `parseTriageV2Extensions()` is a
// pre-zod filter that truncates excess list entries and drops malformed
// inner shapes, then runs zod for type-safety on what remains. This shape
// is the contract between the triage Haiku call and downstream consumers
// (see specs/001-triage-v2/contracts/triage-result.schema.md).
// ---------------------------------------------------------------------------

/** Per-field caps from data-model.md. Tunable in one place. */
const TRIAGE_V2_CAPS = {
  assumptions: 10,
  examples: 3,
  affectedFiles: 20,
  riskAssessmentAreas: 5,
} as const;

export const TriageV2ExtensionsSchema = z
  .object({
    assumptions: z.array(z.string().min(1)).max(TRIAGE_V2_CAPS.assumptions).optional(),
    examples: z
      .array(
        z.object({
          scenario: z.string().min(1),
          expected: z.string().min(1),
        }),
      )
      .max(TRIAGE_V2_CAPS.examples)
      .optional(),
    affectedFiles: z.array(z.string().min(1)).max(TRIAGE_V2_CAPS.affectedFiles).optional(),
    testStrategy: z
      .object({
        unit: z.string().min(1).optional(),
        integration: z.string().min(1).optional(),
      })
      .optional(),
    riskAssessment: z
      .object({
        severity: z.enum(["low", "medium", "high"]),
        areas: z.array(z.string().min(1)).max(TRIAGE_V2_CAPS.riskAssessmentAreas),
      })
      .optional(),
  })
  .strict();

export type TriageV2Extensions = z.infer<typeof TriageV2ExtensionsSchema>;

/**
 * Tolerant pre-zod normaliser. Filters non-string elements from string
 * arrays, drops examples missing `scenario` or `expected`, truncates list
 * fields to their caps, and trims whitespace. Returns only the v2 fields
 * present in `raw`; absent fields are absent from the result (not set to
 * empty arrays).
 *
 * Drops the entire `riskAssessment` block when the severity enum fails so
 * the caller falls back to the v1 shape rather than partially-populated
 * v2.
 */
export function parseTriageV2Extensions(raw: unknown): TriageV2Extensions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // string-array fields with truncate + filter + trim.
  const collectStringArray = (
    field: "assumptions" | "affectedFiles",
    cap: number,
  ): string[] | undefined => {
    const value = r[field];
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
      .filter((v): v is string => typeof v === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return cleaned.length === 0 ? undefined : cleaned.slice(0, cap);
  };
  const assumptions = collectStringArray("assumptions", TRIAGE_V2_CAPS.assumptions);
  if (assumptions) out.assumptions = assumptions;
  const affectedFiles = collectStringArray("affectedFiles", TRIAGE_V2_CAPS.affectedFiles);
  if (affectedFiles) {
    // Haiku sometimes echoes markdown-bullet syntax from the issue description
    // into the affectedFiles array as a string prefix (`"* CLAUDE.md"`,
    // `"- src/foo.ts"`, `"1. src/bar.ts"`). Strip those + surrounding backticks
    // so downstream consumers (Linear comment render, description appender,
    // Tier 6e prediction-quality comparison) see raw paths.
    const normalized = affectedFiles
      .map((p) =>
        p
          .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "") // leading bullet (-, *, +, 1., 1)) — \s* not \s+ so a lone bullet char also gets stripped
          .replace(/^`+|`+$/g, "")                  // surrounding backticks
          .trim(),
      )
      .filter((p) => p.length > 0);
    if (normalized.length > 0) out.affectedFiles = normalized;
  }

  // examples — drop entries missing either field.
  if (Array.isArray(r.examples)) {
    const cleaned = r.examples
      .filter(
        (e): e is { scenario: string; expected: string } =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as { scenario?: unknown }).scenario === "string" &&
          typeof (e as { expected?: unknown }).expected === "string" &&
          ((e as { scenario: string }).scenario.trim().length > 0) &&
          ((e as { expected: string }).expected.trim().length > 0),
      )
      .map((e) => ({ scenario: e.scenario.trim(), expected: e.expected.trim() }));
    if (cleaned.length > 0) {
      out.examples = cleaned.slice(0, TRIAGE_V2_CAPS.examples);
    }
  }

  // testStrategy — keep whichever sub-fields are present and string-typed.
  if (typeof r.testStrategy === "object" && r.testStrategy !== null && !Array.isArray(r.testStrategy)) {
    const ts = r.testStrategy as { unit?: unknown; integration?: unknown };
    const out2: { unit?: string; integration?: string } = {};
    if (typeof ts.unit === "string" && ts.unit.trim().length > 0) out2.unit = ts.unit.trim();
    if (typeof ts.integration === "string" && ts.integration.trim().length > 0) {
      out2.integration = ts.integration.trim();
    }
    if (Object.keys(out2).length > 0) out.testStrategy = out2;
  }

  // riskAssessment — strict severity enum check; drop block on miss.
  if (typeof r.riskAssessment === "object" && r.riskAssessment !== null && !Array.isArray(r.riskAssessment)) {
    const ra = r.riskAssessment as { severity?: unknown; areas?: unknown };
    if (ra.severity === "low" || ra.severity === "medium" || ra.severity === "high") {
      const rawAreas = Array.isArray(ra.areas) ? ra.areas : [];
      const cleanedAreas = rawAreas
        .filter((v): v is string => typeof v === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, TRIAGE_V2_CAPS.riskAssessmentAreas);
      out.riskAssessment = { severity: ra.severity, areas: cleanedAreas };
    }
  }

  // Final zod safety net — should always succeed at this point.
  const parsed = TriageV2ExtensionsSchema.safeParse(out);
  return parsed.success ? parsed.data : {};
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

/**
 * BEC-223: A single issue that has hit the circuit-breaker threshold (≥ N
 * consecutive failed pipeline runs). Populated by fetchCircuitBrokenIssues
 * in db-queries.ts and surfaced in the daily Slack digest.
 */
export interface CircuitBrokenIssue {
  issueId: string;
  issueTitle: string;
  /** Most-recent failed run's error message, if any. */
  errorMessage?: string;
  /** Timestamp of the most recent failure (completedAt ?? startedAt of that run). */
  failedAt: Date;
  /** Linear issue URL for hyperlinking in Slack messages. Optional — rendered as
   *  plain identifier when absent. */
  url?: string;
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
  /** Per-scope budget breakdown from the evaluation (team/repo/global). */
  budgetScopes?: ScopeBudget[];
  /** True when the PM Agent is paused — promote/deprioritize/cancel were skipped. */
  paused?: boolean;
  /** Issue identifiers auto-recovered from stuck "In Progress" state. */
  recoveredStuckIssues?: string[];
  /** Todo issues that were started by the tick (orphaned from webhook). */
  startedTodoIssues?: Array<{ identifier: string; started: boolean; reason: string }>;
  /**
   * BEC-223: Issues that have hit the circuit-breaker threshold (≥ maxConsecutiveFailures
   * consecutive failures in the last 7 days). Rendered as a section in the daily Slack digest.
   * Empty array / undefined → section omitted from digest.
   */
  circuitBrokenIssues?: CircuitBrokenIssue[];
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
