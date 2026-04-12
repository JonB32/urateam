import { sql, and, gte, lt } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { AnyDb } from "../db/client.js";
import type { BudgetGuardResult } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:budget" });

export interface BudgetGuardInput {
  db: AnyDb;
  maxInFlight: number;
  dailyTokenBudget: number;
}

export async function checkBudgetGuards(input: BudgetGuardInput): Promise<BudgetGuardResult> {
  const { db, maxInFlight, dailyTokenBudget } = input;

  const today = new Date().toISOString().slice(0, 10);
  const dayStart = new Date(`${today}T00:00:00Z`);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  let totalIn = 0;
  let totalOut = 0;
  let activeCount = 0;

  try {
    const rows = await db
      .select({
        totalIn: sql<number>`coalesce(sum(${pipelineRuns.totalInputTokens}), 0)`,
        totalOut: sql<number>`coalesce(sum(${pipelineRuns.totalOutputTokens}), 0)`,
        activeCount: sql<number>`coalesce(sum(case when ${pipelineRuns.status} in ('queued', 'running') then 1 else 0 end), 0)`,
      })
      .from(pipelineRuns)
      .where(
        and(
          gte(pipelineRuns.startedAt, dayStart),
          lt(pipelineRuns.startedAt, dayEnd),
        ),
      );

    const row = rows[0];
    if (row) {
      totalIn = Number(row.totalIn);
      totalOut = Number(row.totalOut);
      activeCount = Number(row.activeCount);
    }
  } catch (err) {
    log.error({ err }, "failed to query budget data");
  }

  const dailyTokensUsed = totalIn + totalOut;
  const tokenSpendPercent = dailyTokenBudget > 0
    ? Math.round((dailyTokensUsed / dailyTokenBudget) * 100)
    : 0;

  if (activeCount >= maxInFlight) {
    return {
      promoteBlocked: true,
      reason: `maxInFlight reached (${activeCount}/${maxInFlight})`,
      activeCount,
      tokenSpendPercent,
      dailyTokensUsed,
    };
  }

  if (tokenSpendPercent >= 80) {
    return {
      promoteBlocked: true,
      reason: `token budget at ${tokenSpendPercent}% (${dailyTokensUsed.toLocaleString()}/${dailyTokenBudget.toLocaleString()})`,
      activeCount,
      tokenSpendPercent,
      dailyTokensUsed,
    };
  }

  return {
    promoteBlocked: false,
    activeCount,
    tokenSpendPercent,
    dailyTokensUsed,
  };
}
