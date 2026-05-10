import { Hono } from "hono";
import { desc, eq, inArray, count } from "drizzle-orm";
import type { Db } from "@urateam/core";
import {
  pipelineRuns,
  stageRuns,
  agentLogs,
  logAuditEvent,
  dashboardRetryRunEvent,
  isFeatureLicensed,
  canAccess,
  type Role,
} from "@urateam/core";
import { layout } from "../views/layout.js";
import { runFeedView, type RunRow } from "../views/run-feed.js";
import { runDetailView, type RunInfo, type StageInfo, type LogEntry } from "../views/run-detail.js";
import { requirePermission } from "../middleware/rbac.js";

type AnyDb = any;

export interface RunsRouterDeps {
  db: Db;
  runner?: {
    resume: (runOrIssueId: string) => Promise<void>;
    start: (...args: any[]) => Promise<void>;
  };
  basePath?: string;
}

export function createRunsRouter(
  dbOrDeps: Db | RunsRouterDeps,
  basePath = "",
): Hono {
  // Backwards-compatible: accept either (db, basePath) or a deps object.
  let db: Db;
  let runner: RunsRouterDeps["runner"];
  let effectiveBasePath: string;
  if (
    dbOrDeps &&
    typeof dbOrDeps === "object" &&
    "db" in (dbOrDeps as any)
  ) {
    const deps = dbOrDeps as RunsRouterDeps;
    db = deps.db;
    runner = deps.runner;
    effectiveBasePath = deps.basePath ?? "";
  } else {
    db = dbOrDeps as Db;
    effectiveBasePath = basePath;
  }

  const router = new Hono();
  const d = db as AnyDb;

  router.get("/", requirePermission("runs.view"), async (c) => {
    const runs = await d
      .select()
      .from(pipelineRuns)
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(50) as RunRow[];

    const content = runFeedView(runs);

    if (c.req.header("HX-Request")) {
      return c.html(content);
    }

    const user = c.get("user" as never) as { email?: string } | undefined;
    return c.html(layout("Pipeline Runs", content, effectiveBasePath, { userEmail: user?.email }));
  });

  // HTMX partial: feed of latest pipeline runs (polled every 5s)
  router.get("/runs/feed", requirePermission("runs.view"), async (c) => {
    const runs = await d
      .select()
      .from(pipelineRuns)
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(50) as RunRow[];

    return c.html(runFeedView(runs));
  });

  router.get("/runs/:id", requirePermission("runs.view"), async (c) => {
    const id = c.req.param("id");
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const logsPerPage = 50;
    const user = c.get("user" as never) as
      | { id: string; email: string; role?: Role }
      | undefined;

    const [run] = await d
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1) as (RunInfo | undefined)[];

    if (!run) {
      return c.html(layout("Not Found", "<p>Run not found</p>", effectiveBasePath, { userEmail: user?.email }), 404);
    }

    const stages = await d
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, id))
      .orderBy(stageRuns.startedAt) as StageInfo[];

    const stageIds = stages.map((s) => s.id);

    let totalLogs = 0;
    let logs: LogEntry[] = [];

    if (stageIds.length > 0) {
      const [countResult] = await d
        .select({ cnt: count() })
        .from(agentLogs)
        .where(inArray(agentLogs.stageRunId, stageIds))
        .limit(1) as ({ cnt: number } | undefined)[];
      totalLogs = countResult?.cnt ?? 0;

      const offset = (page - 1) * logsPerPage;
      logs = await d
        .select()
        .from(agentLogs)
        .where(inArray(agentLogs.stageRunId, stageIds))
        .orderBy(agentLogs.timestamp)
        .limit(logsPerPage)
        .offset(offset) as LogEntry[];
    }

    const canRetry = isFeatureLicensed("rbac")
      ? canAccess((user?.role ?? "viewer") as Role, "runs.retry")
      : false;
    const content = runDetailView(run, stages, logs, page, totalLogs, canRetry);
    return c.html(layout(`Run ${id}`, content, effectiveBasePath, { userEmail: user?.email }));
  });

  router.post(
    "/runs/:id/retry",
    async (c, next) => {
      // Per spec §10: retry endpoint returns 404 when RBAC is unlicensed.
      // Without this gate the endpoint would be wide-open in unlicensed
      // deployments because requirePermission is a no-op then.
      if (!isFeatureLicensed("rbac")) return c.notFound();
      return next();
    },
    requirePermission("runs.retry"),
    async (c) => {
      const id = c.req.param("id");
      const rows = await d
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.id, id))
        .limit(1);
      if (rows.length === 0) {
        return c.text("Run not found", 404);
      }
      const run = rows[0] as any;
      if (run.status !== "failed" && run.status !== "retriable") {
        return c.text(`Cannot retry a run in status ${run.status}`, 409);
      }

      if (!runner) {
        return c.text("Runner not configured", 500);
      }

      try {
        if (run.resumePayload) {
          await runner.resume(id);
        } else {
          await runner.start({
            issueId: run.issueId,
            issueTitle: run.issueTitle,
            repoUrl: run.repoUrl,
            parentRunId: id,
          });
        }
      } catch (err) {
        return c.text(`Retry failed: ${(err as Error).message}`, 500);
      }

      const user = c.get("user" as never) as
        | { id: string; email: string }
        | undefined;
      if (user) {
        void logAuditEvent(
          db as any,
          dashboardRetryRunEvent({
            runId: id,
            issueId: run.issueId,
            previousStatus: run.status,
            actorUserId: user.id,
            actorEmail: user.email,
          }),
        );
      }
      // HTMX-driven submits (the real user path — CSRF requires HX-Request)
      // need HX-Redirect for a full-page navigation. A plain 302 makes HTMX
      // follow the redirect via XHR and swap the response into the originating
      // form, leaving the <dialog> open with the run-detail page rendered
      // inside the dialog's <form>.
      const target = `${effectiveBasePath}/runs/${id}`;
      if (c.req.header("HX-Request")) {
        c.header("HX-Redirect", target);
        return c.body(null, 200);
      }
      return c.redirect(target, 302);
    },
  );

  return router;
}
