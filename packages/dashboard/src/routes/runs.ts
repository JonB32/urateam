import { Hono } from "hono";
import { desc, eq, inArray, count } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import type { Db } from "@urateam/core";
import {
  pipelineRuns,
  stageRuns,
  agentLogs,
  logAuditEvent,
  dashboardRetryRunEvent,
  runCancelledEvent,
  systemHaltedEvent,
  isFeatureLicensed,
  canAccess,
  type Role,
  type StopMode,
} from "@urateam/core";
import { layout } from "../views/layout.js";
import { runFeedView, type RunRow } from "../views/run-feed.js";
import { runDetailView, type RunInfo, type StageInfo, type LogEntry } from "../views/run-detail.js";
import { requirePermission } from "../middleware/rbac.js";

type AnyDb = any;

/**
 * Run statuses that are definitively done — no further transitions are
 * possible and stop/cancel signals are a no-op.
 */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "aborted", "cancelled"] as const;

/** Returns true when a run status is eligible for retry. */
function isRetryableStatus(status: string): boolean {
  return status === "failed" || status === "retriable";
}

export interface RunsRouterDeps {
  db: Db;
  runner?: {
    resume: (runOrIssueId: string) => Promise<void>;
    start: (...args: any[]) => Promise<void>;
    /** Single-run stop. Looks up the issueId for the runId and records a stop signal. */
    requestStop?: (runId: string, mode: StopMode) => { issueId: string | null; mode: StopMode };
    /** Container-wide halt: pauses PM Agent + cancels every active run. */
    haltAll?: () => { cancelledRunIds: string[] };
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

  // ---------------------------------------------------------------------------
  // Shared helpers (closed over db/runner/d so they don't need extra args)
  // ---------------------------------------------------------------------------

  /**
   * RBAC-license gate middleware. Returns 404 (not 403) when the RBAC feature
   * is unlicensed so that the endpoint surface is not discoverable in OSS
   * deployments. Use instead of inlining `isFeatureLicensed("rbac")` in every
   * route middleware chain.
   */
  const requireRbac = async (c: any, next: any) => {
    if (!isFeatureLicensed("rbac")) return c.notFound();
    return next();
  };

  /**
   * Fetch a pipeline run row by its id. Returns `null` when not found so
   * handlers can choose their own 404 shape (text vs HTML).
   */
  async function fetchRunById(id: string): Promise<any | null> {
    const rows = await d
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id))
      .limit(1);
    return rows.length > 0 ? (rows[0] as any) : null;
  }

  /**
   * Resume or start a pipeline run (the "retry" logic shared between the
   * dashboard and CLI retry handlers).
   */
  async function retryRun(id: string, run: any): Promise<void> {
    if (run.resumePayload) {
      await runner!.resume(id);
    } else {
      await runner!.start({
        issueId: run.issueId,
        issueTitle: run.issueTitle,
        repoUrl: run.repoUrl,
        parentRunId: id,
      });
    }
  }

  /**
   * Emit per-run audit events after a halt. Uses a single batched
   * `inArray()` query so 10+ cancelled runs don't trigger 10+ round-trips.
   */
  async function auditCancelledRunsBatch(
    cancelledRunIds: string[],
    actor: string,
    actorType: string,
  ): Promise<void> {
    if (cancelledRunIds.length === 0) return;
    const rows = await d
      .select({ id: pipelineRuns.id, issueId: pipelineRuns.issueId })
      .from(pipelineRuns)
      .where(inArray(pipelineRuns.id, cancelledRunIds));
    const issueMap = new Map<string, string>(
      rows.map((r: any) => [r.id as string, r.issueId as string]),
    );
    for (const runId of cancelledRunIds) {
      const issueId = issueMap.get(runId);
      if (issueId) {
        void logAuditEvent(
          db as any,
          runCancelledEvent({
            runId,
            issueId,
            actor,
            actorType,
            mode: "cancel",
            reason: "system.halt",
          }),
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

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

    const run = await fetchRunById(id) as RunInfo | null;

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

    // Cache the rbac license check — isFeatureLicensed may involve a lookup
    // and is needed three times in quick succession here.
    const rbacLicensed = isFeatureLicensed("rbac");
    const canRetry = rbacLicensed
      ? canAccess((user?.role ?? "viewer") as Role, "runs.retry")
      : false;
    const canStop = rbacLicensed
      ? canAccess((user?.role ?? "viewer") as Role, "runs.stop")
      : false;
    const canHalt = rbacLicensed
      ? canAccess((user?.role ?? "viewer") as Role, "system.halt")
      : false;
    const content = runDetailView(run, stages, logs, page, totalLogs, canRetry, {
      canStop,
      canHalt,
    });
    return c.html(layout(`Run ${id}`, content, effectiveBasePath, { userEmail: user?.email }));
  });

  router.post(
    "/runs/:id/retry",
    requireRbac,
    requirePermission("runs.retry"),
    async (c) => {
      const id = c.req.param("id");
      const run = await fetchRunById(id);
      if (!run) return c.text("Run not found", 404);
      if (!isRetryableStatus(run.status)) {
        return c.text(`Cannot retry a run in status ${run.status}`, 409);
      }

      if (!runner) {
        return c.text("Runner not configured", 500);
      }

      try {
        await retryRun(id, run);
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

  /**
   * Single-run stop. Two modes:
   *  - POST /runs/:id/cancel  — interrupt the active stage stream immediately.
   *  - POST /runs/:id/stop    — let the current stage finish, then stop.
   *
   * Both share the same handler factory; `mode` is bound at registration. The
   * RBAC gate is `runs.stop` (operator+admin). Idempotent — calling on a run
   * that's already terminal returns 409 so the operator gets feedback instead
   * of silently accumulating audit events.
   */
  const stopHandler = (mode: StopMode) => async (c: any) => {
    const id = c.req.param("id");
    const run = await fetchRunById(id);
    if (!run) return c.text("Run not found", 404);
    if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return c.text(`Cannot stop a run in status ${run.status}`, 409);
    }

    if (!runner?.requestStop) return c.text("Runner not configured", 500);
    const { issueId } = runner.requestStop(id, mode);

    const user = c.get("user" as never) as { id: string; email: string } | undefined;
    if (user) {
      void logAuditEvent(
        db as any,
        runCancelledEvent({
          runId: id,
          issueId: issueId ?? run.issueId,
          actor: `dashboard:${user.email}`,
          actorType: "dashboard-user",
          mode,
        }),
      );
    }

    const target = `${effectiveBasePath}/runs/${id}`;
    if (c.req.header("HX-Request")) {
      c.header("HX-Redirect", target);
      return c.body(null, 200);
    }
    return c.redirect(target, 302);
  };

  router.post("/runs/:id/cancel", requireRbac, requirePermission("runs.stop"), stopHandler("cancel"));
  router.post("/runs/:id/stop", requireRbac, requirePermission("runs.stop"), stopHandler("graceful"));

  /**
   * Container-wide halt: pauses the PM Agent and cancels every active run.
   * Reversible — operators can unpause via Slack `/pm resume` (or the planned
   * dashboard equivalent) and re-trigger individual runs via retry. Cancelled
   * runs themselves stay cancelled.
   */
  router.post(
    "/admin/halt-all",
    requireRbac,
    requirePermission("system.halt"),
    async (c) => {
      if (!runner?.haltAll) return c.text("Runner not configured", 500);
      const { cancelledRunIds } = runner.haltAll();

      const user = c.get("user" as never) as { id: string; email: string } | undefined;
      if (user) {
        const actor = `dashboard:${user.email}`;
        void logAuditEvent(
          db as any,
          systemHaltedEvent({
            actor,
            actorType: "dashboard-user",
            cancelledRunIds,
          }),
        );
        // Per-run audit trail — batched to avoid N+1 queries.
        void auditCancelledRunsBatch(cancelledRunIds, actor, "dashboard-user");
      }

      const target = `${effectiveBasePath}/`;
      if (c.req.header("HX-Request")) {
        c.header("HX-Redirect", target);
        return c.body(null, 200);
      }
      return c.redirect(target, 302);
    },
  );

  /**
   * CLI-facing endpoints. Auth: shared secret in `X-Ura-Cli-Token` matching
   * `URATEAM_CLI_TOKEN`. No RBAC dependency so this works in OSS deployments.
   * Disabled (404) when `URATEAM_CLI_TOKEN` is unset — the absence of the
   * secret is treated as "CLI control is opt-in", not "any caller is allowed".
   *
   * Actor in audit events is `cli:<x-ura-actor>` where the header is provided
   * by the CLI from the local OS user so emergency stops are traceable.
   */
  const requireCliToken = async (c: any, next: any) => {
    const expected = process.env.URATEAM_CLI_TOKEN;
    if (!expected) return c.notFound();
    const got = c.req.header("x-ura-cli-token") ?? "";
    // Constant-time comparison — matches `verifyLinearSignature` and the SSO
    // state-HMAC check. Length-mismatch short-circuits before timingSafeEqual
    // because it requires equal-length buffers.
    let ok = false;
    if (got.length === expected.length) {
      try {
        ok = timingSafeEqual(Buffer.from(got), Buffer.from(expected));
      } catch {
        ok = false;
      }
    }
    if (!ok) return c.text("invalid CLI token", 403);
    return next();
  };
  const cliActor = (c: any): string => `cli:${c.req.header("x-ura-actor") ?? "unknown"}`;

  const cliStopHandler = (mode: StopMode) => async (c: any) => {
    const id = c.req.param("id");
    const run = await fetchRunById(id);
    if (!run) return c.text("Run not found", 404);
    if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return c.json({ error: `Cannot stop a run in status ${run.status}` }, 409);
    }
    if (!runner?.requestStop) return c.text("Runner not configured", 500);
    const { issueId } = runner.requestStop(id, mode);
    void logAuditEvent(
      db as any,
      runCancelledEvent({
        runId: id,
        issueId: issueId ?? run.issueId,
        actor: cliActor(c),
        actorType: "cli",
        mode,
      }),
    );
    return c.json({ runId: id, mode, issueId: issueId ?? run.issueId });
  };

  router.post("/cli/runs/:id/cancel", requireCliToken, cliStopHandler("cancel"));
  router.post("/cli/runs/:id/stop", requireCliToken, cliStopHandler("graceful"));

  const cliRetryHandler = async (c: any) => {
    const id = c.req.param("id");
    const run = await fetchRunById(id);
    if (!run) return c.text("Run not found", 404);
    if (!isRetryableStatus(run.status)) {
      return c.json({ error: `Cannot retry a run in status ${run.status}` }, 409);
    }
    if (!runner) return c.text("Runner not configured", 500);
    const previousStatus = run.status;
    try {
      await retryRun(id, run);
    } catch (err) {
      return c.text(`Retry failed: ${(err as Error).message}`, 500);
    }
    const actor = cliActor(c);
    void logAuditEvent(
      db as any,
      dashboardRetryRunEvent({
        runId: id,
        issueId: run.issueId,
        previousStatus,
        actorUserId: actor,
        actorEmail: actor,
      }),
    );
    return c.json({ runId: id, mode: "retry", issueId: run.issueId });
  };

  router.post("/cli/runs/:id/retry", requireCliToken, cliRetryHandler);

  router.post("/cli/halt-all", requireCliToken, async (c) => {
    if (!runner?.haltAll) return c.text("Runner not configured", 500);
    const { cancelledRunIds } = runner.haltAll();
    const actor = cliActor(c);
    void logAuditEvent(
      db as any,
      systemHaltedEvent({
        actor,
        actorType: "cli",
        cancelledRunIds,
      }),
    );
    // Per-run audit trail — batched to avoid N+1 queries.
    void auditCancelledRunsBatch(cancelledRunIds, actor, "cli");
    return c.json({ cancelledRunIds });
  });

  return router;
}
