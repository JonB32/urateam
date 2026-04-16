import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Db } from "@urateam/core";
import { sqlDateGroup, sqlDaysAgoFilter, stageRuns, pipelineRuns } from "@urateam/core";
import { layout } from "../views/layout.js";
import { tokensView } from "../views/tokens.js";
import { requirePermission } from "../middleware/rbac.js";

type AnyDb = any;

export function createTokensRouter(db: Db, basePath = ""): Hono {
  const router = new Hono();
  const d = db as AnyDb;

  // Driver-agnostic SQL helpers — no isPostgres() branching needed in application code
  const dateExpr = sqlDateGroup(db, stageRuns.startedAt);
  const thirtyDaysAgo = sqlDaysAgoFilter(db, stageRuns.startedAt, 30);

  router.get("/tokens", requirePermission("tokens.view"), async (c) => {
    const daily = await d
      .select({
        date: dateExpr.as("date"),
        inputTokens: sql<number>`COALESCE(SUM(${stageRuns.inputTokens}), 0)`.as("inputTokens"),
        outputTokens: sql<number>`COALESCE(SUM(${stageRuns.outputTokens}), 0)`.as("outputTokens"),
      })
      .from(stageRuns)
      .where(thirtyDaysAgo)
      .groupBy(dateExpr)
      .orderBy(sql`date DESC`);

    const byPipeline = await d
      .select({
        key: pipelineRuns.pipelineKey,
        inputTokens: sql<number>`COALESCE(SUM(${stageRuns.inputTokens}), 0)`.as("inputTokens"),
        outputTokens: sql<number>`COALESCE(SUM(${stageRuns.outputTokens}), 0)`.as("outputTokens"),
      })
      .from(stageRuns)
      .innerJoin(pipelineRuns, sql`${stageRuns.pipelineRunId} = ${pipelineRuns.id}`)
      .groupBy(pipelineRuns.pipelineKey)
      .orderBy(sql`(COALESCE(SUM(${stageRuns.inputTokens}), 0) + COALESCE(SUM(${stageRuns.outputTokens}), 0)) DESC`);

    const byStage = await d
      .select({
        key: stageRuns.stage,
        inputTokens: sql<number>`COALESCE(SUM(${stageRuns.inputTokens}), 0)`.as("inputTokens"),
        outputTokens: sql<number>`COALESCE(SUM(${stageRuns.outputTokens}), 0)`.as("outputTokens"),
      })
      .from(stageRuns)
      .groupBy(stageRuns.stage)
      .orderBy(sql`(COALESCE(SUM(${stageRuns.inputTokens}), 0) + COALESCE(SUM(${stageRuns.outputTokens}), 0)) DESC`);

    const content = tokensView(daily, byPipeline, byStage);
    return c.html(layout("Token Usage", content, basePath));
  });

  return router;
}
