import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "@urateam/core";
import { pipelineRuns, auditEvents } from "@urateam/core/dist/db/schema.js";
import { createRunsRouter } from "../routes/runs.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

let db: any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
  await db.insert(pipelineRuns).values({
    id: "run_1",
    issueId: "BEC-42",
    issueTitle: "fix bug",
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/acme/api",
    status: "failed",
    startedAt: new Date(),
    completedAt: new Date(),
    errorMessage: "boom",
  });
});

afterEach(async () => {
  await restoreLicense();
});

function appWith(
  role: string | undefined,
  runner: any = { resume: vi.fn(), start: vi.fn() },
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (role) {
      c.set("user" as never, {
        id: "u_1",
        email: "u@b.com",
        role,
      } as any);
    }
    await next();
  });
  app.route("/", createRunsRouter({ db, runner, basePath: "" }));
  return app;
}

describe("POST /runs/:id/retry", () => {
  it("unlicensed → middleware is no-op and endpoint redirects", async () => {
    const app = appWith("viewer");
    const res = await app.request("/runs/run_1/retry", { method: "POST" });
    expect([200, 302]).toContain(res.status);
  });

  describe("licensed", () => {
    beforeEach(async () => {
      await installTestProLicense("enterprise");
    });

    it("viewer → 403", async () => {
      const res = await appWith("viewer").request("/runs/run_1/retry", {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });

    it("operator → 302 redirect, runner.resume called, audit event written", async () => {
      // Give the run a resumePayload so runner.resume is called (not start).
      await db
        .update(pipelineRuns)
        .set({ resumePayload: JSON.stringify({ stageIndex: 1 }) })
        .where(eq(pipelineRuns.id, "run_1"));
      const runner = {
        resume: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
      };
      const app = appWith("operator", runner);
      const res = await app.request("/runs/run_1/retry", { method: "POST" });
      expect(res.status).toBe(302);
      expect(runner.resume).toHaveBeenCalledWith("run_1");
      // Give fire-and-forget logAuditEvent a chance to flush
      await new Promise((r) => setTimeout(r, 50));
      const events = await db.select().from(auditEvents);
      const retry = events.find((e: any) => {
        const p =
          typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
        return (
          e.eventType === "dashboard.manual_action" && p.action === "retry_run"
        );
      });
      expect(retry).toBeDefined();
    });

    it("admin → 302, runner.resume called (with resumePayload)", async () => {
      await db
        .update(pipelineRuns)
        .set({ resumePayload: JSON.stringify({ stageIndex: 1 }) })
        .where(eq(pipelineRuns.id, "run_1"));
      const runner = {
        resume: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
      };
      const app = appWith("admin", runner);
      const res = await app.request("/runs/run_1/retry", { method: "POST" });
      expect(res.status).toBe(302);
      expect(runner.resume).toHaveBeenCalled();
    });

    it("operator retrying a completed run → 409", async () => {
      await db
        .update(pipelineRuns)
        .set({ status: "completed" })
        .where(eq(pipelineRuns.id, "run_1"));
      const res = await appWith("operator").request("/runs/run_1/retry", {
        method: "POST",
      });
      expect(res.status).toBe(409);
    });

    it("operator retrying a non-existent run → 404", async () => {
      const res = await appWith("operator").request("/runs/nope/retry", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });
});
