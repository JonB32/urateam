import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { createDb } from "@urateam/core";
import { pipelineRuns } from "@urateam/core/dist/db/schema.js";
import { createRunsRouter } from "../routes/runs.js";

let db: any;

beforeEach(async () => {
  db = await createDb({ connectionString: ":memory:" });
  await db.insert(pipelineRuns).values({
    id: "run_active",
    issueId: "BEC-1",
    issueTitle: "in flight",
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/acme/api",
    status: "running",
    startedAt: new Date(),
  });
  process.env.URATEAM_CLI_TOKEN = "test-token-1234567890-secret";
});

afterEach(() => {
  delete process.env.URATEAM_CLI_TOKEN;
});

function appWith(runner: any) {
  const app = new Hono();
  app.route("/", createRunsRouter({ db, runner, basePath: "" }));
  return app;
}

describe("CLI /cli/* routes — token check", () => {
  it("returns 404 when URATEAM_CLI_TOKEN is unset", async () => {
    delete process.env.URATEAM_CLI_TOKEN;
    const app = appWith({ resume: vi.fn(), start: vi.fn() });
    const res = await app.request("/cli/runs/run_active/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 403 on missing token", async () => {
    const app = appWith({ resume: vi.fn(), start: vi.fn() });
    const res = await app.request("/cli/runs/run_active/cancel", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("returns 403 on wrong token", async () => {
    const app = appWith({ resume: vi.fn(), start: vi.fn() });
    const res = await app.request("/cli/runs/run_active/cancel", {
      method: "POST",
      headers: { "x-ura-cli-token": "wrong" },
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 on token that is the right LENGTH but wrong value (catches non-constant-time regression)", async () => {
    const app = appWith({ resume: vi.fn(), start: vi.fn() });
    const wrong = "x".repeat(process.env.URATEAM_CLI_TOKEN!.length);
    const res = await app.request("/cli/runs/run_active/cancel", {
      method: "POST",
      headers: { "x-ura-cli-token": wrong },
    });
    expect(res.status).toBe(403);
  });

  it("happy path: valid token → runner.requestStop called with cancel mode", async () => {
    const requestStop = vi.fn().mockReturnValue({ issueId: "BEC-1", mode: "cancel" });
    const app = appWith({ resume: vi.fn(), start: vi.fn(), requestStop });
    const res = await app.request("/cli/runs/run_active/cancel", {
      method: "POST",
      headers: {
        "x-ura-cli-token": process.env.URATEAM_CLI_TOKEN!,
        "x-ura-actor": "alice",
      },
    });
    expect(res.status).toBe(200);
    expect(requestStop).toHaveBeenCalledWith("run_active", "cancel");
    const body = await res.json() as any;
    expect(body.runId).toBe("run_active");
    expect(body.mode).toBe("cancel");
  });

  it("happy path: /cli/runs/:id/stop uses graceful mode", async () => {
    const requestStop = vi.fn().mockReturnValue({ issueId: "BEC-1", mode: "graceful" });
    const app = appWith({ resume: vi.fn(), start: vi.fn(), requestStop });
    const res = await app.request("/cli/runs/run_active/stop", {
      method: "POST",
      headers: { "x-ura-cli-token": process.env.URATEAM_CLI_TOKEN! },
    });
    expect(res.status).toBe(200);
    expect(requestStop).toHaveBeenCalledWith("run_active", "graceful");
  });

  it("happy path: /cli/halt-all calls runner.haltAll and returns cancelledRunIds", async () => {
    const haltAll = vi.fn().mockReturnValue({ cancelledRunIds: ["r1", "r2"] });
    const app = appWith({ resume: vi.fn(), start: vi.fn(), haltAll });
    const res = await app.request("/cli/halt-all", {
      method: "POST",
      headers: { "x-ura-cli-token": process.env.URATEAM_CLI_TOKEN! },
    });
    expect(res.status).toBe(200);
    expect(haltAll).toHaveBeenCalled();
    const body = await res.json() as any;
    expect(body.cancelledRunIds).toEqual(["r1", "r2"]);
  });

  it("returns 409 when run is already in a terminal status", async () => {
    await db.update(pipelineRuns).set({ status: "completed" });
    const requestStop = vi.fn();
    const app = appWith({ resume: vi.fn(), start: vi.fn(), requestStop });
    const res = await app.request("/cli/runs/run_active/cancel", {
      method: "POST",
      headers: { "x-ura-cli-token": process.env.URATEAM_CLI_TOKEN! },
    });
    expect(res.status).toBe(409);
    expect(requestStop).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown runId", async () => {
    const requestStop = vi.fn();
    const app = appWith({ resume: vi.fn(), start: vi.fn(), requestStop });
    const res = await app.request("/cli/runs/missing/cancel", {
      method: "POST",
      headers: { "x-ura-cli-token": process.env.URATEAM_CLI_TOKEN! },
    });
    expect(res.status).toBe(404);
    expect(requestStop).not.toHaveBeenCalled();
  });
});
