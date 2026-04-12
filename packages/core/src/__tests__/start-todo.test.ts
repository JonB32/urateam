import { describe, it, expect, vi } from "vitest";
import { startTodoIssues, type StartTodoInput } from "../pm/actions/start-todo.js";

function mockLinearClient(todoIssues: any[]) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: todoIssues }),
  };
}

function mockDb(activeIssueIds: string[]) {
  return {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(activeIssueIds.map((id) => ({ issueId: id }))),
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
  });

  it("skips Todo issue that already has an active run", async () => {
    const issue = makeIssue({ id: "uuid-1" });
    const runner = { start: vi.fn() };
    const input: StartTodoInput = {
      linearClient: mockLinearClient([issue]),
      db: mockDb(["uuid-1"]),
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
});
