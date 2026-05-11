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
  markRunAsResumeEligible,
  removeActiveWorkForRun,
  type Role,
} from "@urateam/core";
import { layout } from "../views/layout.js";
import { runFeedView, type RunRow } from "../views/run-feed.js";
import { runDetailView, type RunInfo, type StageInfo, type LogEntry } from "../views/run-detail.js";
import { requirePermission } from "../middleware/rbac.js";

type AnyDb = any;

/** Fetches a pipeline run by ID; returns null if not found. */
async function getRunById(d: AnyDb, id: string): Promise<any | null> {
  const rows = await d
    .select()
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, id))
    .limit(1);
  return rows.length > 0 ? (rows[0] as any) : null;
}

/**
 * Handles HTMX-aware redirects.
 * HTMX submits need HX-Redirect for full-page navigation; a plain 302 would
 * swap the destination page into the originating element instead.
 */
function handleHtmxRedirect(c: any, target: string) {
  if (c.req.header("HX-Request")) {
    c.header("HX-Redirect", target);
    return c.body(null, 200);
  }
  return c.redirect(target, 302);
}

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
      const run = await getRunById(d, id);
      if (!run) {
        return c.text("Run not found", 404);
      }
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
      return handleHtmxRedirect(c, `${effectiveBasePath}/runs/${id}`);
    },
  );

  /**
   * BEC-210: Resume a stalled run.
   *
   * A run is "stalled" when its pipeline is still status="running" but has
   * made no active_work progress for > the stall threshold (default 30 min).
   * This endpoint:
   *   1. Marks the pipeline_runs row as "retriable" so the next PM tick
   *      recovery sweep can re-queue it.
   *   2. Removes the stale active_work row so stall detection won't re-alert.
   *   3. Optionally calls runner.resume(id) immediately if available.
   *
   * Accessible to admin and operator roles (uses runs.retry permission).
   * Does NOT require RBAC license — always accessible as a safety valve.
   */
  router.post(
    "/runs/:id/resume-stalled",
    requirePermission("runs.retry"),
    async (c) => {
      const id = c.req.param("id");
      const run = await getRunById(d, id);
      if (!run) {
        return c.text("Run not found", 404);
      }
      if (run.status !== "running") {
        return c.text(
          `Cannot resume-stalled a run in status ${run.status} — only 'running' runs can be resumed via this endpoint`,
          409,
        );
      }

      try {
        // Mark the run as retriable so the next PM tick's recovery sweep
        // picks it up (same path as transient failure recovery).
        await markRunAsResumeEligible(d as any, id);

        // Remove the stale active_work row to stop stall-detection re-alerting.
        await removeActiveWorkForRun(d as any, id);

        // Immediately re-queue via runner if available and run has a resume
        // checkpoint (best-effort; the PM recovery sweep will catch it next
        // tick if runner is absent or this call fails).
        if (runner && run.resumePayload) {
          await runner.resume(id);
        }
      } catch (err) {
        return c.text(`Resume failed: ${(err as Error).message}`, 500);
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
            previousStatus: "running (stalled)",
            actorUserId: user.id,
            actorEmail: user.email,
          }),
        );
      }

      return handleHtmxRedirect(c, `${effectiveBasePath}/runs/${id}`);
    },
  );

  return router;
}
