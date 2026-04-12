import { describe, it, expect, vi } from "vitest";
import { recoverRetriableRuns } from "../pm/actions/recover.js";

function makeRetriableRun(id: string, issueId: string, retryCount = 1) {
  return {
    id,
    issueId,
    status: "retriable",
    retryCount,
    resumePayload: JSON.stringify({
      handoff: null,
      pipelineConfig: { name: "test", stages: ["implement", "test"], retry: { maxAttempts: 1, strategy: "fix-and-retry" }, review: { requiredApprovals: 0 }, prStrategy: "draft" },
      repoConfig: { url: "https://github.com/test/repo", defaultBranch: "main", testCommand: "npm test", buildCommand: "npm run build" },
      sanitizedIssue: { id: "issue-1", identifier: issueId, title: "Test", slug: "test", description: "", labels: [], teamId: "t1" },
      worktreePath: "/var/agent-runs/run-1/worktree",
    }),
    currentStageIndex: 0,
    errorMessage: "401 auth error",
  };
}

describe("recoverRetriableRuns", () => {
  it("requeues retriable runs under max retries", async () => {
    const runs = [makeRetriableRun("run-1", "BEC-100", 1)];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(runs),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const runner = { resume: vi.fn().mockResolvedValue(undefined) };

    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });

    expect(result.recovered).toEqual(["BEC-100"]);
    expect(runner.resume).toHaveBeenCalledWith("BEC-100");
  });

  it("fails runs that exceed max retries", async () => {
    const runs = [makeRetriableRun("run-1", "BEC-200", 3)];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(runs),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const runner = { resume: vi.fn() };

    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });

    expect(result.exhausted).toEqual(["BEC-200"]);
    expect(runner.resume).not.toHaveBeenCalled();
  });

  it("rolls back to retriable when runner.resume() throws", async () => {
    const runs = [makeRetriableRun("run-1", "BEC-300", 1)];
    const updateCalls: Array<{ status: string }> = [];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(runs),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((values: any) => {
          updateCalls.push(values);
          return {
            where: vi.fn().mockResolvedValue(undefined),
          };
        }),
      }),
    };
    const runner = { resume: vi.fn().mockRejectedValue(new Error("resume failed")) };

    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });

    // Should NOT be in recovered (resume failed)
    expect(result.recovered).toEqual([]);
    // First update sets "paused", second rolls back to "retriable"
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0].status).toBe("paused");
    expect(updateCalls[1].status).toBe("retriable");
  });

  it("returns empty arrays when no retriable runs exist", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
    const runner = { resume: vi.fn() };

    const result = await recoverRetriableRuns({ db: db as any, runner: runner as any, maxRetries: 3 });

    expect(result.recovered).toEqual([]);
    expect(result.exhausted).toEqual([]);
  });
});
