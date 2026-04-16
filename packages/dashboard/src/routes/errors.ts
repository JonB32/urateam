import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Db } from "@urateam/core";
import { stageRuns } from "@urateam/core";
import { layout } from "../views/layout.js";
import { errorsView } from "../views/errors.js";
import { requirePermission } from "../middleware/rbac.js";

type AnyDb = any;

export function createErrorsRouter(db: Db, basePath = ""): Hono {
  const router = new Hono();
  const d = db as AnyDb;

  router.get("/errors", requirePermission("errors.view"), async (c) => {
    const stageFailures = await d
      .select({
        stage: stageRuns.stage,
        totalRuns: sql<number>`COUNT(*)`.as("totalRuns"),
        failedRuns: sql<number>`SUM(CASE WHEN ${stageRuns.status} = 'failed' THEN 1 ELSE 0 END)`.as("failedRuns"),
        failureRate: sql<number>`ROUND(CAST(SUM(CASE WHEN ${stageRuns.status} = 'failed' THEN 1 ELSE 0 END) AS NUMERIC) / COUNT(*) * 100, 1)`.as("failureRate"),
      })
      .from(stageRuns)
      .groupBy(stageRuns.stage)
      .orderBy(sql`"failureRate" DESC`);

    const errorPatterns = await d
      .select({
        stage: stageRuns.stage,
        errorMessage: sql<string>`${stageRuns.errorMessage}`.as("errorMessage"),
        count: sql<number>`COUNT(*)`.as("count"),
      })
      .from(stageRuns)
      .where(sql`${stageRuns.status} = 'failed' AND ${stageRuns.errorMessage} IS NOT NULL`)
      .groupBy(stageRuns.stage, stageRuns.errorMessage)
      .orderBy(sql`"count" DESC`)
      .limit(50);

    const content = errorsView(stageFailures, errorPatterns);
    const user = c.get("user" as never) as { email?: string } | undefined;
    return c.html(layout("Errors", content, basePath, { userEmail: user?.email }));
  });

  return router;
}
