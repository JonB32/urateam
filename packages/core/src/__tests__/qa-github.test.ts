import { describe, it, expect, vi } from "vitest";
import {
  triggerWorkflow,
  pollWorkflowRun,
  workflowFileExists,
} from "../qa/github.js";
import type { AnyDb } from "../db/client.js";

const fakeDb = {} as AnyDb;
const owner = "org";
const repo = "repo";

function makeMockOctokit(over: any = {}) {
  return {
    actions: {
      createWorkflowDispatch: vi.fn(async () => ({ status: 204 })),
      listWorkflowRuns: vi.fn(async () => ({
        data: { workflow_runs: [{ id: 99999, head_sha: "abc123", status: "in_progress", conclusion: null, created_at: "2026-05-04T12:00:00Z", run_started_at: "2026-05-04T12:00:00Z" }] },
      })),
      getWorkflowRun: vi.fn(async () => ({
        data: { id: 99999, head_sha: "abc123", status: "in_progress", conclusion: null, run_started_at: "2026-05-04T12:00:00Z", updated_at: "2026-05-04T12:10:00Z" },
      })),
    },
    repos: {
      getContent: vi.fn(async () => ({ data: { type: "file", path: ".github/workflows/smoke.yml" } })),
    },
    ...over,
  } as any;
}

describe("workflowFileExists", () => {
  it("returns true when file content is fetched successfully", async () => {
    const octokit = makeMockOctokit();
    const exists = await workflowFileExists({ octokit, owner, repo, path: ".github/workflows/smoke.yml", ref: "main" });
    expect(exists).toBe(true);
    expect(octokit.repos.getContent).toHaveBeenCalledWith({ owner, repo, path: ".github/workflows/smoke.yml", ref: "main" });
  });
  it("returns false on 404", async () => {
    const octokit = makeMockOctokit({
      repos: {
        getContent: vi.fn(async () => {
          const err: any = new Error("Not Found");
          err.status = 404;
          throw err;
        }),
      },
    });
    const exists = await workflowFileExists({ octokit, owner, repo, path: ".github/workflows/smoke.yml", ref: "main" });
    expect(exists).toBe(false);
  });
  it("rethrows on 5xx", async () => {
    const octokit = makeMockOctokit({
      repos: {
        getContent: vi.fn(async () => {
          const err: any = new Error("Server Error");
          err.status = 500;
          throw err;
        }),
      },
    });
    await expect(
      workflowFileExists({ octokit, owner, repo, path: ".github/workflows/smoke.yml", ref: "main" })
    ).rejects.toThrow("Server Error");
  });
});

describe("triggerWorkflow", () => {
  it("calls createWorkflowDispatch then finds the new run by SHA", async () => {
    const octokit = makeMockOctokit();
    const result = await triggerWorkflow({
      octokit,
      db: fakeDb,
      owner,
      repo,
      repoUrl: `https://github.com/${owner}/${repo}`,
      branch: "main",
      workflow: ".github/workflows/smoke.yml",
      ref: "abc123",
      inputs: { environment: "preview" },
    });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.runId).toBe(99999);
    expect(octokit.actions.createWorkflowDispatch).toHaveBeenCalledWith({
      owner,
      repo,
      workflow_id: ".github/workflows/smoke.yml",
      ref: "abc123",
      inputs: { environment: "preview" },
    });
  });

  it("returns dispatch_404 on 404 (workflow file missing)", async () => {
    const octokit = makeMockOctokit({
      actions: {
        createWorkflowDispatch: vi.fn(async () => {
          const err: any = new Error("Not Found");
          err.status = 404;
          throw err;
        }),
      },
    });
    const result = await triggerWorkflow({
      octokit, db: fakeDb, owner, repo, repoUrl: `https://github.com/${owner}/${repo}`, branch: "main",
      workflow: ".github/workflows/smoke.yml", ref: "abc123",
    });
    expect(result.kind).toBe("dispatch_404");
  });

  it("returns dispatch_422 on 422 (workflow not workflow_dispatch-triggered)", async () => {
    const octokit = makeMockOctokit({
      actions: {
        createWorkflowDispatch: vi.fn(async () => {
          const err: any = new Error("Unprocessable Entity");
          err.status = 422;
          throw err;
        }),
      },
    });
    const result = await triggerWorkflow({
      octokit, db: fakeDb, owner, repo, repoUrl: `https://github.com/${owner}/${repo}`, branch: "main",
      workflow: ".github/workflows/smoke.yml", ref: "abc123",
    });
    expect(result.kind).toBe("dispatch_422");
  });

  it("returns dispatch_error on 5xx", async () => {
    const octokit = makeMockOctokit({
      actions: {
        createWorkflowDispatch: vi.fn(async () => {
          const err: any = new Error("Server Error");
          err.status = 502;
          throw err;
        }),
      },
    });
    const result = await triggerWorkflow({
      octokit, db: fakeDb, owner, repo, repoUrl: `https://github.com/${owner}/${repo}`, branch: "main",
      workflow: ".github/workflows/smoke.yml", ref: "abc123",
    });
    expect(result.kind).toBe("dispatch_error");
    expect(result.kind === "dispatch_error" && result.message).toMatch(/Server Error/);
  });
});

describe("pollWorkflowRun", () => {
  it("returns running for in_progress runs", async () => {
    const octokit = makeMockOctokit();
    const result = await pollWorkflowRun({ octokit, owner, repo, runId: 99999 });
    expect(result.kind).toBe("running");
  });

  it("returns completed with conclusion=success", async () => {
    const octokit = makeMockOctokit({
      actions: {
        getWorkflowRun: vi.fn(async () => ({
          data: { id: 99999, status: "completed", conclusion: "success", run_started_at: "2026-05-04T12:00:00Z", updated_at: "2026-05-04T12:10:00Z" },
        })),
      },
    });
    const result = await pollWorkflowRun({ octokit, owner, repo, runId: 99999 });
    expect(result.kind).toBe("completed");
    expect(result.kind === "completed" && result.conclusion).toBe("success");
    expect(result.kind === "completed" && result.durationMs).toBe(10 * 60 * 1000);
  });

  it("returns completed with conclusion=failure", async () => {
    const octokit = makeMockOctokit({
      actions: {
        getWorkflowRun: vi.fn(async () => ({
          data: { id: 99999, status: "completed", conclusion: "failure", run_started_at: "2026-05-04T12:00:00Z", updated_at: "2026-05-04T12:05:00Z" },
        })),
      },
    });
    const result = await pollWorkflowRun({ octokit, owner, repo, runId: 99999 });
    expect(result.kind).toBe("completed");
    expect(result.kind === "completed" && result.conclusion).toBe("failure");
  });
});
