import { describe, it, expect, vi } from "vitest";
import { promoteReadyIssues } from "../pm/actions/promote.js";

function mockLinearClient(issues: any[]) {
  // Linear SDK returns labels as an async connection: `await issue.labels()` → { nodes }.
  // Existing fixtures use `labels: { nodes: [...] }` as a plain object; wrap as a function
  // so promote.ts can use the same `await issue.labels()` pattern as start-todo.ts.
  for (const i of issues) {
    if (i.labels && typeof i.labels !== "function") {
      const fixture = i.labels;
      i.labels = vi.fn().mockResolvedValue(fixture);
    }
  }
  return {
    issues: vi.fn().mockResolvedValue({ nodes: issues }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
  };
}

// Test helper: resolvePipeline only checks `configs[label]` for truthiness, so the
// shape doesn't matter for these tests. Cast as `any` to avoid duplicating the
// full PipelineConfig schema in test fixtures.
function pipelineConfig(label: string): any {
  return { label, stages: [], maxTurns: 25 };
}

const defaultStateMap = new Map([["team-1:Todo", "state-todo"]]);

describe("promoteReadyIssues", () => {
  it("promotes highest-priority issue to Todo", async () => {
    const issues = [
      { id: "i1", identifier: "BEC-50", title: "Urgent fix", description: "desc", priority: 1, labels: { nodes: [{ name: "bug" }] }, team: { id: "team-1" }, url: "https://linear.app/BEC-50" },
      { id: "i2", identifier: "BEC-51", title: "Nice to have", description: "desc", priority: 3, labels: { nodes: [] }, team: { id: "team-1" }, url: "https://linear.app/BEC-51" },
    ];
    const client = mockLinearClient(issues);
    const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

    const results = await promoteReadyIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slotsAvailable: 1,
      checkConflict: conflictChecker,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(1);
    expect(results[0].issueId).toBe("BEC-50");
    expect(results[0].promoted).toBe(true);
    expect(client.updateIssue).toHaveBeenCalledWith("i1", expect.objectContaining({ stateId: "state-todo" }));
  });

  it("skips high-conflict candidate and takes next", async () => {
    const issues = [
      { id: "i1", identifier: "BEC-50", title: "Risky", description: "touches auth", priority: 1, labels: { nodes: [] }, team: { id: "team-1" }, url: "https://linear.app/BEC-50" },
      { id: "i2", identifier: "BEC-51", title: "Safe", description: "add docs", priority: 2, labels: { nodes: [] }, team: { id: "team-1" }, url: "https://linear.app/BEC-51" },
    ];
    const client = mockLinearClient(issues);
    const conflictChecker = vi.fn()
      .mockResolvedValueOnce({ overlapRisk: "high", likelyFiles: ["src/auth.ts"], reasoning: "overlap" })
      .mockResolvedValueOnce({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

    const results = await promoteReadyIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slotsAvailable: 1,
      checkConflict: conflictChecker,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(2);
    expect(results[0].promoted).toBe(false);
    expect(results[0].reason).toContain("conflict");
    expect(results[1].promoted).toBe(true);
  });

  it("returns empty when no candidates", async () => {
    const client = mockLinearClient([]);
    const conflictChecker = vi.fn();

    const results = await promoteReadyIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slotsAvailable: 3,
      checkConflict: conflictChecker,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(0);
  });

  it("stops after filling available slots", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({
      id: `i${i}`, identifier: `BEC-${60 + i}`, title: `Issue ${i}`, description: "d", priority: 2,
      labels: { nodes: [] }, team: { id: "team-1" }, url: `https://linear.app/BEC-${60 + i}`,
    }));
    const client = mockLinearClient(issues);
    const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

    const results = await promoteReadyIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slotsAvailable: 2,
      checkConflict: conflictChecker,
      stateMap: defaultStateMap,
    });

    const promoted = results.filter((r) => r.promoted);
    expect(promoted).toHaveLength(2);
  });

  describe("requirePipelineLabel option (BEC-150)", () => {
    it("promotes when issue has a pipeline-matching label", async () => {
      const issues = [
        {
          id: "i1", identifier: "BEC-100", title: "Tech debt", description: "small",
          priority: 2, labels: { nodes: [{ name: "quick-fix" }] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-100",
        },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        requirePipelineLabel: true,
        pipelineConfigs: { "quick-fix": pipelineConfig("quick-fix") },
      });

      expect(results).toHaveLength(1);
      expect(results[0].promoted).toBe(true);
      expect(client.updateIssue).toHaveBeenCalled();
    });

    it("skips promote when requirePipelineLabel=true and no label matches a configured pipeline", async () => {
      const issues = [
        {
          id: "i1", identifier: "BEC-200", title: "Strategy doc", description: "planning",
          priority: 2, labels: { nodes: [{ name: "marketing" }] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-200",
        },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        requirePipelineLabel: true,
        pipelineConfigs: { "quick-fix": pipelineConfig("quick-fix"), "auto-implement": pipelineConfig("auto-implement") },
      });

      expect(results).toHaveLength(1);
      expect(results[0].promoted).toBe(false);
      expect(results[0].reason).toContain("no pipeline-matching label");
      expect(client.updateIssue).not.toHaveBeenCalled();
    });

    it("skips promote when requirePipelineLabel=true and issue has no labels at all", async () => {
      const issues = [
        {
          id: "i1", identifier: "BEC-300", title: "Unlabeled", description: "",
          priority: 2, labels: { nodes: [] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-300",
        },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        requirePipelineLabel: true,
        pipelineConfigs: { "quick-fix": pipelineConfig("quick-fix") },
      });

      expect(results[0].promoted).toBe(false);
      expect(client.updateIssue).not.toHaveBeenCalled();
    });

    it("preserves existing behavior (promotes regardless of label) when requirePipelineLabel is false / unset", async () => {
      const issues = [
        {
          id: "i1", identifier: "BEC-400", title: "Unlabeled", description: "",
          priority: 2, labels: { nodes: [] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-400",
        },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        // requirePipelineLabel omitted (default false)
        // pipelineConfigs also omitted
      });

      expect(results[0].promoted).toBe(true);
      expect(client.updateIssue).toHaveBeenCalled();
    });

    it("requirePipelineLabel=true without pipelineConfigs throws clear error (misconfiguration)", async () => {
      const issues = [
        {
          id: "i1", identifier: "BEC-500", title: "x", description: "",
          priority: 2, labels: { nodes: [{ name: "quick-fix" }] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-500",
        },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

      await expect(
        promoteReadyIssues({
          linearClient: client as any,
          teamIds: ["team-1"],
          slotsAvailable: 1,
          checkConflict: conflictChecker,
          stateMap: defaultStateMap,
          requirePipelineLabel: true,
          // pipelineConfigs intentionally missing
        }),
      ).rejects.toThrow(/pipelineConfigs/);
    });

    it("checks label match BEFORE conflict-detection (saves Claude tokens)", async () => {
      const issues = [
        {
          id: "i1", identifier: "BEC-600", title: "Unlabeled", description: "",
          priority: 2, labels: { nodes: [] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-600",
        },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

      await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        requirePipelineLabel: true,
        pipelineConfigs: { "quick-fix": pipelineConfig("quick-fix") },
      });

      expect(conflictChecker).not.toHaveBeenCalled();
    });
  });
});
