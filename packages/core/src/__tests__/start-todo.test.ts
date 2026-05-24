import { describe, it, expect, vi } from "vitest";
import { startTodoIssues, type StartTodoInput } from "../pm/actions/start-todo.js";

function mockLinearClient(todoIssues: any[]) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: todoIssues }),
  };
}

function mockDb(activeIssueIds: string[], recentIds: string[] = []) {
  const whereFn = vi.fn()
    .mockResolvedValueOnce(activeIssueIds.map((id) => ({ issueId: id })))
    .mockResolvedValueOnce(recentIds.map((id) => ({ issueId: id })));
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: whereFn,
      }),
    }),
  } as any;
}

function makeIssue(overrides: Partial<{
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  teamId: string;
  projectId: string;
  labels: Array<{ name: string }>;
}> = {}) {
  const teamId = overrides.teamId ?? "team-1";
  return {
    id: overrides.id ?? "uuid-1",
    identifier: overrides.identifier ?? "BEC-200",
    title: overrides.title ?? "Test issue",
    description: overrides.description ?? "Fix the thing",
    priority: overrides.priority ?? 2,
    team: Promise.resolve({ id: teamId }),
    project: Promise.resolve({ id: overrides.projectId ?? "proj-1" }),
    labels: () => Promise.resolve({ nodes: overrides.labels ?? [{ name: "auto-implement" }] }),
  };
}

describe("startTodoIssues", () => {
  const pipelineConfigs: Record<string, any> = {
    "auto-implement": {
      stages: ["triage", "implement", "review"],
      retryStrategy: "linear",
    },
  };

  const repoConfigs: Record<string, any> = {
    "team-1": {
      url: "https://github.com/test/repo",
      defaultBranch: "main",
    },
  };

  it("starts pipeline for Todo issue with no active run", async () => {
    const issue = makeIssue();
    const runner = { start: vi.fn().mockResolvedValue(undefined) };
    const input: StartTodoInput = {
      linearClient: mockLinearClient([issue]),
      db: mockDb([]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
    };

    const results = await startTodoIssues(input);

    expect(results).toHaveLength(1);
    expect(results[0].identifier).toBe("BEC-200");
    expect(results[0].started).toBe(true);
    expect(runner.start).toHaveBeenCalledOnce();
    // Regression: linearTeamId must be propagated as the 6th argument so spend-cap
    // accounting per team works. Previously defaulted to null, breaking team scopes.
    const callArgs = runner.start.mock.calls[0];
    expect(callArgs.length).toBeGreaterThanOrEqual(6);
    expect(callArgs[5]).toBe("team-1");
  });

  it("skips Todo issue that already has an active run", async () => {
    const issue = makeIssue({ id: "uuid-1", identifier: "BEC-200" });
    const runner = { start: vi.fn() };
    const input: StartTodoInput = {
      linearClient: mockLinearClient([issue]),
      db: mockDb(["BEC-200"]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
    };

    const results = await startTodoIssues(input);

    expect(results).toHaveLength(0);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("skips Todo issue with a recently completed pipeline run", async () => {
    const issue = makeIssue({ id: "uuid-1", identifier: "BEC-200" });
    const runner = { start: vi.fn() };
    const input: StartTodoInput = {
      linearClient: mockLinearClient([issue]),
      // No active runs, but BEC-200 has a recent completed run
      db: mockDb([], ["BEC-200"]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
    };

    const results = await startTodoIssues(input);

    expect(results).toHaveLength(0);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("skips issue with no matching pipeline config", async () => {
    const issue = makeIssue({ labels: [{ name: "unknown-label" }] });
    const runner = { start: vi.fn() };
    const input: StartTodoInput = {
      linearClient: mockLinearClient([issue]),
      db: mockDb([]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
    };

    const results = await startTodoIssues(input);

    expect(results).toHaveLength(1);
    expect(results[0].started).toBe(false);
    expect(results[0].reason).toContain("no pipeline");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("skips issue with no matching repo config", async () => {
    const issue = makeIssue({ teamId: "unknown-team", projectId: "unknown-proj" });
    const runner = { start: vi.fn() };
    const input: StartTodoInput = {
      linearClient: mockLinearClient([issue]),
      db: mockDb([]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
    };

    const results = await startTodoIssues(input);

    expect(results).toHaveLength(1);
    expect(results[0].started).toBe(false);
    expect(results[0].reason).toContain("no repo");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("respects maxPerTick rate limit", async () => {
    const issues = [
      makeIssue({ id: "uuid-1", identifier: "BEC-201" }),
      makeIssue({ id: "uuid-2", identifier: "BEC-202" }),
      makeIssue({ id: "uuid-3", identifier: "BEC-203" }),
    ];
    const runner = { start: vi.fn().mockResolvedValue(undefined) };
    const input: StartTodoInput = {
      linearClient: mockLinearClient(issues),
      db: mockDb([]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 2,
    };

    const results = await startTodoIssues(input);

    const started = results.filter((r) => r.started);
    expect(started).toHaveLength(2);
    expect(runner.start).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when no Todo issues exist", async () => {
    const runner = { start: vi.fn() };
    const input: StartTodoInput = {
      linearClient: mockLinearClient([]),
      db: mockDb([]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
    };

    const results = await startTodoIssues(input);

    expect(results).toHaveLength(0);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("continues processing when one issue fails to start", async () => {
    const issues = [
      makeIssue({ id: "uuid-1", identifier: "BEC-301" }),
      makeIssue({ id: "uuid-2", identifier: "BEC-302" }),
    ];
    const runner = {
      start: vi.fn()
        .mockRejectedValueOnce(new Error("clone failed"))
        .mockResolvedValueOnce(undefined),
    };
    const input: StartTodoInput = {
      linearClient: mockLinearClient(issues),
      db: mockDb([]),
      teamIds: ["team-1"],
      runner: runner as any,
      pipelineConfigs,
      repoConfigs,
      maxPerTick: 5,
    };

    const results = await startTodoIssues(input);

    expect(results).toHaveLength(2);
    expect(results[0].started).toBe(false);
    expect(results[0].reason).toContain("clone failed");
    expect(results[1].started).toBe(true);
  });

  describe("BEC-177: label-based repo routing", () => {
    it("routes ticket with observer-fix label to observer repo via labelPattern", async () => {
      // Two pipelines: auto-implement (urateam) and observer-fix (observer repo)
      const multiPipelineConfigs: Record<string, any> = {
        "auto-implement": {
          stages: ["implement", "review"],
          retryStrategy: "linear",
        },
        "observer-fix": {
          stages: ["implement", "review"],
          retryStrategy: "linear",
        },
      };
      const multiRepoConfigs: Record<string, any> = {
        "urateam-main": {
          url: "https://github.com/JonB32/urateam",
          defaultBranch: "main",
          labelPattern: "auto-implement",
        },
        "observer-repo": {
          url: "https://github.com/JonB32/urateam-quality-observer",
          defaultBranch: "main",
          labelPattern: "observer-fix",
        },
      };

      const issue = makeIssue({ labels: [{ name: "observer-fix" }] });
      const runner = { start: vi.fn().mockResolvedValue(undefined) };
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs: multiPipelineConfigs,
        repoConfigs: multiRepoConfigs,
        maxPerTick: 5,
      };

      const results = await startTodoIssues(input);

      expect(results).toHaveLength(1);
      expect(results[0].started).toBe(true);
      expect(results[0].reason).toContain("observer-fix");
      expect(runner.start).toHaveBeenCalledOnce();

      // Verify the observer repo config was passed (4th arg to runner.start)
      const callArgs = runner.start.mock.calls[0];
      expect(callArgs[3].url).toBe("https://github.com/JonB32/urateam-quality-observer");
    });

    it("existing auto-implement tickets still route to urateam via labelPattern (no migration required)", async () => {
      const multiPipelineConfigs: Record<string, any> = {
        "auto-implement": {
          stages: ["implement", "review"],
          retryStrategy: "linear",
        },
      };
      const multiRepoConfigs: Record<string, any> = {
        "urateam-main": {
          url: "https://github.com/JonB32/urateam",
          defaultBranch: "main",
          labelPattern: "auto-implement",
        },
        "observer-repo": {
          url: "https://github.com/JonB32/urateam-quality-observer",
          defaultBranch: "main",
          labelPattern: "observer-fix",
        },
      };

      const issue = makeIssue({ labels: [{ name: "auto-implement" }] });
      const runner = { start: vi.fn().mockResolvedValue(undefined) };
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs: multiPipelineConfigs,
        repoConfigs: multiRepoConfigs,
        maxPerTick: 5,
      };

      const results = await startTodoIssues(input);

      expect(results[0].started).toBe(true);
      const callArgs = runner.start.mock.calls[0];
      expect(callArgs[3].url).toBe("https://github.com/JonB32/urateam");
    });

    it("falls back to teamId key lookup when no labelPattern matches (backwards compatibility)", async () => {
      // Legacy config: key = teamId, no labelPattern
      const issue = makeIssue({ labels: [{ name: "auto-implement" }] });
      const runner = { start: vi.fn().mockResolvedValue(undefined) };
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs,
        repoConfigs, // uses "team-1" as key, no labelPattern
        maxPerTick: 5,
      };

      const results = await startTodoIssues(input);

      expect(results[0].started).toBe(true);
      const callArgs = runner.start.mock.calls[0];
      expect(callArgs[3].url).toBe("https://github.com/test/repo");
    });

    it("skips issue when no repo config matches by label or teamId", async () => {
      const multiRepoConfigs: Record<string, any> = {
        "observer-repo": {
          url: "https://github.com/JonB32/urateam-quality-observer",
          defaultBranch: "main",
          labelPattern: "observer-fix",
        },
      };

      // Issue labelled "auto-implement" but no repoConfig for it (no labelPattern, no teamId key)
      const issue = makeIssue({ teamId: "unknown-team", labels: [{ name: "auto-implement" }] });
      const runner = { start: vi.fn() };
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs,
        repoConfigs: multiRepoConfigs,
        maxPerTick: 5,
      };

      const results = await startTodoIssues(input);

      expect(results[0].started).toBe(false);
      expect(results[0].reason).toContain("no repo");
      expect(runner.start).not.toHaveBeenCalled();
    });
  });

  describe("circuit breaker (BEC-161)", () => {
    it("skips Todo issue with N+ consecutive failed runs WITHOUT touching Linear SDK (saves 3 round-trips)", async () => {
      // Spy on the Linear-SDK awaits so we can assert the breaker fires
      // before any of them — proving the doom-looping ticket cost is just
      // the cheap getFailureCount call, not 3 expensive SDK round-trips.
      const labelsSpy = vi.fn().mockResolvedValue({ nodes: [{ name: "auto-implement" }] });
      const issue = {
        ...makeIssue({ identifier: "BEC-161-T1" }),
        labels: labelsSpy,
      };
      const teamSpy = vi.spyOn(issue as any, "team", "get");
      const projectSpy = vi.spyOn(issue as any, "project", "get");
      const runner = { start: vi.fn() };
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs,
        repoConfigs,
        maxPerTick: 5,
        maxConsecutiveFailures: 3,
        getFailureCount: vi.fn().mockResolvedValue(3),
      };

      const results = await startTodoIssues(input);

      expect(results).toHaveLength(1);
      expect(results[0].started).toBe(false);
      expect(results[0].reason).toMatch(/circuit.breaker/i);
      expect(runner.start).not.toHaveBeenCalled();
      expect(labelsSpy).not.toHaveBeenCalled();
      expect(teamSpy).not.toHaveBeenCalled();
      expect(projectSpy).not.toHaveBeenCalled();
    });

    it("starts Todo issue with fewer than N consecutive failures", async () => {
      const issue = makeIssue({ identifier: "BEC-161-T2" });
      const runner = { start: vi.fn().mockResolvedValue(undefined) };
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs,
        repoConfigs,
        maxPerTick: 5,
        maxConsecutiveFailures: 3,
        getFailureCount: vi.fn().mockResolvedValue(2),
      };

      const results = await startTodoIssues(input);

      expect(results[0].started).toBe(true);
      expect(runner.start).toHaveBeenCalledOnce();
    });

    it("breaker disabled when maxConsecutiveFailures is undefined (back-compat)", async () => {
      const issue = makeIssue({ identifier: "BEC-161-T3" });
      const runner = { start: vi.fn().mockResolvedValue(undefined) };
      const getFailureCount = vi.fn().mockResolvedValue(99);
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs,
        repoConfigs,
        maxPerTick: 5,
        // maxConsecutiveFailures intentionally omitted
        getFailureCount,
      };

      const results = await startTodoIssues(input);

      expect(results[0].started).toBe(true);
      expect(getFailureCount).not.toHaveBeenCalled();
    });

    it("bypasses the breaker skip for issues in probeOverrideIds (BEC-236)", async () => {
      // Same setup as the "skips Todo issue" breaker test but with probeOverrideIds
      // containing the issue identifier — the circuit-broken issue should be started.
      const labelsSpy = vi.fn().mockResolvedValue({ nodes: [{ name: "auto-implement" }] });
      const issue = {
        ...makeIssue({ identifier: "BEC-161-T1" }),
        labels: labelsSpy,
      };
      const runner = { start: vi.fn().mockResolvedValue(undefined) };
      const input: StartTodoInput = {
        linearClient: mockLinearClient([issue]),
        db: mockDb([]),
        teamIds: ["team-1"],
        runner: runner as any,
        pipelineConfigs,
        repoConfigs,
        maxPerTick: 5,
        maxConsecutiveFailures: 3,
        getFailureCount: vi.fn().mockResolvedValue(3),
        probeOverrideIds: new Set(["BEC-161-T1"]),
      };

      const results = await startTodoIssues(input);

      // The issue is circuit-broken (3 >= 3) but in probeOverrideIds, so it
      // should be started rather than skipped.
      expect(results).toHaveLength(1);
      expect(results[0].started).toBe(true);
      expect(results[0].identifier).toBe("BEC-161-T1");
      expect(runner.start).toHaveBeenCalledOnce();
    });
  });
});
