import { describe, it, expect, vi } from "vitest";
import { promoteReadyIssues } from "../pm/actions/promote.js";

function mockLinearClient(issues: any[]) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: issues }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
  };
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
});
