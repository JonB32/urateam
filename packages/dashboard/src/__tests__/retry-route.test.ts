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
  it("unlicensed → 404 even for valid retry requests", async () => {
    // Do NOT install enterprise license
    const runner = { resume: vi.fn(), start: vi.fn() };
    const app = appWith("operator", runner); // operator role set but feature off
    const res = await app.request("/runs/run_1/retry", { method: "POST" });
    expect(res.status).toBe(404);
    expect(runner.resume).not.toHaveBeenCalled();
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

    it("operator → 302 redirect, runner.resume called with issueId, audit event written", async () => {
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
      // retryRun must pass issueId ("BEC-42"), not the run primary key ("run_1")
      expect(runner.resume).toHaveBeenCalledWith("BEC-42");
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

    it("operator retrying a retriable run → 302, runner.resume called with issueId", async () => {
      await db
        .update(pipelineRuns)
        .set({
          status: "retriable",
          resumePayload: JSON.stringify({ stageIndex: 2 }),
        })
        .where(eq(pipelineRuns.id, "run_1"));
      const runner = {
        resume: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
      };
      const app = appWith("operator", runner);
      const res = await app.request("/runs/run_1/retry", { method: "POST" });
      expect(res.status).toBe(302);
      expect(runner.resume).toHaveBeenCalledWith("BEC-42");
      // Audit event must fire for retriable retries too
      await new Promise((r) => setTimeout(r, 50));
      const events = await db.select().from(auditEvents);
      const retry = events.find((e: any) => {
        const p =
          typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
        return (
          e.eventType === "dashboard.manual_action" &&
          p.action === "retry_run" &&
          p.previousStatus === "retriable"
        );
      });
      expect(retry).toBeDefined();
    });

    it("operator retrying a failed run with no resumePayload → 422 (BEC-226: cannot reconstruct Linear/repo/pipeline context from a bare DB row)", async () => {
      // run_1 has no resumePayload (default fixture in beforeEach)
      const runner = {
        resume: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
      };
      const app = appWith("operator", runner);
      const res = await app.request("/runs/run_1/retry", { method: "POST" });
      expect(res.status).toBe(422);
      const body = await res.text();
      expect(body).toContain("no resumePayload");
      expect(runner.start).not.toHaveBeenCalled();
      expect(runner.resume).not.toHaveBeenCalled();
    });

    it("admin → 302, runner.resume called with issueId (with resumePayload)", async () => {
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
      expect(runner.resume).toHaveBeenCalledWith("BEC-42");
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

    it("HX-Request header → 200 with HX-Redirect, not a 302 (so HTMX does full-page nav instead of swapping into the open dialog)", async () => {
      await db
        .update(pipelineRuns)
        .set({ resumePayload: JSON.stringify({ stageIndex: 1 }) })
        .where(eq(pipelineRuns.id, "run_1"));
      const runner = {
        resume: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
      };
      const app = appWith("operator", runner);
      const res = await app.request("/runs/run_1/retry", {
        method: "POST",
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("HX-Redirect")).toBe("/runs/run_1");
      expect(res.headers.get("Location")).toBeNull();
      expect(runner.resume).toHaveBeenCalledWith("BEC-42");
    });
  });
});

describe("GET /runs/:id retry button visibility", () => {
  it("hides retry control when rbac is unlicensed", async () => {
    // No license installed (afterEach in this file already calls restoreLicense)
    const app = appWith("operator");
    const res = await app.request("/runs/run_1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("/runs/run_1/retry");
    expect(html).not.toContain("<dialog");
  });

  it("shows retry control when rbac is licensed and role permits", async () => {
    await installTestProLicense("enterprise");
    const app = appWith("operator");
    const res = await app.request("/runs/run_1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/runs/run_1/retry");
    expect(html).toContain("<dialog");
  });
});
