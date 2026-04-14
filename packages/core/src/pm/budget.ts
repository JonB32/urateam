import { sql, and, gte, lt } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type {
  BudgetEvaluation,
  BudgetScope,
  BudgetTier,
  PmAgentConfig,
  ScopeBudget,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:budget" });

export interface BudgetEvaluationInput {
  db: AnyDb;
  config: PmAgentConfig;
}

/**
 * Evaluate today's token spend against the configured budgets and return
 * a per-scope breakdown plus a `worstTier` / `promoteBlocked` verdict.
 *
 * Scopes evaluated:
 * - Always: `global` (limit = config.dailyTokenBudget)
 * - If `config.budgets?.perTeam` is set OR rows have a non-null linear_team_id,
 *   one `team` scope per team that appears in either source.
 * - If `config.budgets?.perRepo` is set OR rows exist, one `repo` scope per repo.
 *
 * A scope's limit is resolved as:
 *   perTeam[teamId] / perRepo[repoUrl] ?? budgets.default ?? dailyTokenBudget
 *
 * Tier thresholds (inclusive lower bound, using Math.floor for percent):
 *   percent >= 100 → blocked-100
 *   percent >=  80 → warn-80
 *   percent >=  50 → warn-50
 *   else          → ok
 *
 * `worstTier` is the highest tier across all scopes. `promoteBlocked` is true
 * iff `worstTier === 'blocked-100'`. `blockReason` names the first blocking
 * scope with its percent and token usage, for inclusion in logs and Linear
 * comments.
 */
export async function evaluateBudget(
  input: BudgetEvaluationInput,
): Promise<BudgetEvaluation> {
  const { db, config } = input;

  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(`${today}T00:00:00Z`);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  interface Row {
    linearTeamId: string | null;
    repoUrl: string;
    totalTokens: number;
    activeCount: number;
  }
  let rows: Row[] = [];

  try {
    rows = (await db
      .select({
        linearTeamId: pipelineRuns.linearTeamId,
        repoUrl: pipelineRuns.repoUrl,
        totalTokens: sql<number>`coalesce(sum(${pipelineRuns.totalInputTokens} + ${pipelineRuns.totalOutputTokens}), 0)`,
        activeCount: sql<number>`coalesce(sum(case when ${pipelineRuns.status} in ('queued', 'running') then 1 else 0 end), 0)`,
      })
      .from(pipelineRuns)
      .where(
        and(
          gte(pipelineRuns.startedAt, dayStart),
          lt(pipelineRuns.startedAt, dayEnd),
        ),
      )
      .groupBy(pipelineRuns.linearTeamId, pipelineRuns.repoUrl)) as Row[];
  } catch (err) {
    log.error({ err }, "failed to query budget data");
    rows = [];
  }

  const globalLimit = config.dailyTokenBudget;
  const defaultLimit = config.budgets?.default ?? globalLimit;

  // Aggregate
  let globalUsed = 0;
  let activeCount = 0;
  const teamUsed = new Map<string, number>();
  const repoUsed = new Map<string, number>();

  for (const row of rows) {
    const tokens = Number(row.totalTokens) || 0;
    globalUsed += tokens;
    activeCount += Number(row.activeCount) || 0;
    if (row.linearTeamId) {
      teamUsed.set(row.linearTeamId, (teamUsed.get(row.linearTeamId) ?? 0) + tokens);
    }
    repoUsed.set(row.repoUrl, (repoUsed.get(row.repoUrl) ?? 0) + tokens);
  }

  // Ensure configured teams/repos appear even with 0 spend so alert thresholds can fire on them
  for (const teamId of Object.keys(config.budgets?.perTeam ?? {})) {
    if (!teamUsed.has(teamId)) teamUsed.set(teamId, 0);
  }
  for (const repoUrl of Object.keys(config.budgets?.perRepo ?? {})) {
    if (!repoUsed.has(repoUrl)) repoUsed.set(repoUrl, 0);
  }

  const scopes: ScopeBudget[] = [];

  scopes.push(makeScope({ kind: "global" }, globalUsed, globalLimit));

  for (const [teamId, used] of teamUsed) {
    const limit = config.budgets?.perTeam?.[teamId] ?? defaultLimit;
    scopes.push(makeScope({ kind: "team", teamId }, used, limit));
  }

  for (const [repoUrl, used] of repoUsed) {
    const limit = config.budgets?.perRepo?.[repoUrl] ?? defaultLimit;
    scopes.push(makeScope({ kind: "repo", repoUrl }, used, limit));
  }

  // Derive worstTier and blockReason
  const tierRank: Record<BudgetTier, number> = {
    ok: 0,
    "warn-50": 1,
    "warn-80": 2,
    "blocked-100": 3,
  };
  let worstTier: BudgetTier = "ok";
  let blockReason: string | undefined;

  for (const s of scopes) {
    if (tierRank[s.tier] > tierRank[worstTier]) worstTier = s.tier;
    if (s.tier === "blocked-100" && !blockReason) {
      blockReason = `${s.scopeLabel} at ${s.percent}% (${s.used.toLocaleString()} / ${s.limit.toLocaleString()} tokens)`;
    }
  }

  return {
    scopes,
    worstTier,
    promoteBlocked: worstTier === "blocked-100",
    blockReason,
    activeCount,
  };
}

function makeScope(
  scope: BudgetScope,
  used: number,
  limit: number,
): ScopeBudget {
  const percent = limit > 0 ? Math.floor((used / limit) * 100) : 0;
  let tier: BudgetTier = "ok";
  if (percent >= 100) tier = "blocked-100";
  else if (percent >= 80) tier = "warn-80";
  else if (percent >= 50) tier = "warn-50";

  return {
    scope,
    scopeLabel: formatScopeLabel(scope),
    limit,
    used,
    percent,
    tier,
  };
}

function formatScopeLabel(scope: BudgetScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "team") return `team ${scope.teamId}`;
  return `repo ${scope.repoUrl}`;
}

