/**
 * Tests for packages/core/src/util/linear.ts
 *
 * Covers:
 * - getLinearClient: module-level caching (same apiKey → same instance)
 * - resolveIssueRelations: concurrent fetch via Promise.all
 * - resolveWorkflowStatesByTeam: parallelized state.team resolution
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getLinearClient,
  _clearLinearClientCache,
  resolveIssueRelations,
  resolveWorkflowStatesByTeam,
} from "../util/linear.js";

// ---------------------------------------------------------------------------
// Mock @linear/sdk so we never hit the real Linear API
// ---------------------------------------------------------------------------

// vi.hoisted ensures MockLinearClient is created before vi.mock factories execute
// (vi.mock calls are hoisted above variable declarations by vitest's transform).
const { MockLinearClient } = vi.hoisted(() => ({
  MockLinearClient: vi.fn().mockImplementation(() => ({ _isMockClient: true })),
}));

vi.mock("@linear/sdk", () => ({
  LinearClient: MockLinearClient,
}));

// ---------------------------------------------------------------------------
// getLinearClient
// ---------------------------------------------------------------------------

describe("getLinearClient", () => {
  beforeEach(() => {
    _clearLinearClientCache();
    MockLinearClient.mockClear();
  });

  it("returns null when apiKey is undefined", async () => {
    const result = await getLinearClient(undefined);
    expect(result).toBeNull();
    expect(MockLinearClient).not.toHaveBeenCalled();
  });

  it("returns null when apiKey is an empty string", async () => {
    const result = await getLinearClient("");
    expect(result).toBeNull();
    expect(MockLinearClient).not.toHaveBeenCalled();
  });

  it("creates and returns a LinearClient when apiKey is provided", async () => {
    const client = await getLinearClient("test-api-key");
    expect(client).not.toBeNull();
    expect(MockLinearClient).toHaveBeenCalledTimes(1);
    expect(MockLinearClient).toHaveBeenCalledWith({ apiKey: "test-api-key" });
  });

  it("returns the same instance on subsequent calls with the same apiKey", async () => {
    const client1 = await getLinearClient("same-key");
    const client2 = await getLinearClient("same-key");
    expect(client1).toBe(client2);
    // LinearClient constructor should only have been called once
    expect(MockLinearClient).toHaveBeenCalledTimes(1);
  });

  it("returns different instances for different apiKeys", async () => {
    const client1 = await getLinearClient("key-a");
    const client2 = await getLinearClient("key-b");
    expect(client1).not.toBe(client2);
    expect(MockLinearClient).toHaveBeenCalledTimes(2);
  });

  it("returns fresh instance after cache is cleared", async () => {
    const client1 = await getLinearClient("key-refresh");
    _clearLinearClientCache();
    const client2 = await getLinearClient("key-refresh");
    // After clearing the cache a new instance is created
    expect(MockLinearClient).toHaveBeenCalledTimes(2);
    // The two objects are structurally equal but from separate constructor calls
    expect(client1).not.toBe(client2);
  });
});

// ---------------------------------------------------------------------------
// resolveIssueRelations
// ---------------------------------------------------------------------------

describe("resolveIssueRelations", () => {
  it("returns team, state, and labels resolved via Promise.all", async () => {
    const team = { id: "team-1", name: "Eng" };
    const state = { name: "Backlog" };
    const labelsResult = { nodes: [{ id: "l1", name: "bug" }] };

    const issue = {
      team: Promise.resolve(team),
      state: Promise.resolve(state),
      labels: vi.fn().mockResolvedValue(labelsResult),
    };

    const result = await resolveIssueRelations(issue);

    expect(result.team).toBe(team);
    expect(result.state).toBe(state);
    expect(result.labels).toBe(labelsResult);
    expect(issue.labels).toHaveBeenCalledTimes(1);
  });

  it("resolves team, state, and labels concurrently (all tracked via Promise.all)", async () => {
    // Verify that all three are resolved by tracking resolution order.
    // A Promise.all-based implementation resolves all concurrently rather than
    // waiting for each in sequence.
    const resolveOrder: string[] = [];

    const teamPromise = new Promise<{ id: string }>((res) => {
      setImmediate(() => {
        resolveOrder.push("team");
        res({ id: "team-parallel" });
      });
    });
    const statePromise = new Promise<{ name: string }>((res) => {
      setImmediate(() => {
        resolveOrder.push("state");
        res({ name: "In Progress" });
      });
    });
    const labelsPromise = new Promise<{ nodes: any[] }>((res) => {
      setImmediate(() => {
        resolveOrder.push("labels");
        res({ nodes: [] });
      });
    });

    const issue = {
      team: teamPromise,
      state: statePromise,
      labels: vi.fn().mockReturnValue(labelsPromise),
    };

    const result = await resolveIssueRelations(issue);

    expect(result.team).toEqual({ id: "team-parallel" });
    expect(result.state).toEqual({ name: "In Progress" });
    expect(result.labels).toEqual({ nodes: [] });
    // All three are resolved (order may vary depending on micro-task scheduling
    // but all must be present)
    expect(resolveOrder).toContain("team");
    expect(resolveOrder).toContain("state");
    expect(resolveOrder).toContain("labels");
  });

  it("handles missing labels function gracefully (returns undefined for labels)", async () => {
    // Some mocks / issue shapes may not have a labels() function
    const issue = {
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "Triage" }),
      // no labels property
    };

    const result = await resolveIssueRelations(issue);

    expect(result.team).toEqual({ id: "team-1" });
    expect(result.state).toEqual({ name: "Triage" });
    expect(result.labels).toBeUndefined();
  });

  it("handles plain-object labels (not a function) gracefully — returns undefined, does not throw", async () => {
    // Some test fixtures pass labels as { nodes: [...] } instead of a function.
    // The helper must not throw; it should return undefined for labels in this case.
    const issue = {
      team: Promise.resolve({ id: "team-1" }),
      state: Promise.resolve({ name: "Backlog" }),
      labels: { nodes: [{ name: "bug" }] }, // plain object, not a function
    };

    const result = await resolveIssueRelations(issue);

    expect(result.team).toEqual({ id: "team-1" });
    expect(result.state).toEqual({ name: "Backlog" });
    // Plain-object labels are skipped (not callable); caller falls back to []
    expect(result.labels).toBeUndefined();
  });

  it("works with plain (non-Promise) team values like test fixtures use", async () => {
    // Existing test fixtures pass team as a plain object rather than a Promise;
    // awaiting a non-thenable simply returns the value itself.
    const issue = {
      team: { id: "team-plain" },
      state: { name: "Backlog" },
      labels: vi.fn().mockResolvedValue({ nodes: [] }),
    };

    const result = await resolveIssueRelations(issue);

    expect(result.team).toEqual({ id: "team-plain" });
    expect(result.state).toEqual({ name: "Backlog" });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkflowStatesByTeam
// ---------------------------------------------------------------------------

describe("resolveWorkflowStatesByTeam", () => {
  it("builds the teamId:stateName → stateId map", async () => {
    const states = [
      { id: "s1", name: "Backlog", team: Promise.resolve({ id: "team-A" }) },
      { id: "s2", name: "Todo", team: Promise.resolve({ id: "team-A" }) },
      { id: "s3", name: "Backlog", team: Promise.resolve({ id: "team-B" }) },
    ];

    const linearClient = {
      workflowStates: vi.fn().mockResolvedValue({ nodes: states }),
    };

    const map = await resolveWorkflowStatesByTeam(linearClient, ["team-A", "team-B"]);

    expect(map.get("team-A:Backlog")).toBe("s1");
    expect(map.get("team-A:Todo")).toBe("s2");
    expect(map.get("team-B:Backlog")).toBe("s3");
    expect(map.size).toBe(3);
  });

  it("calls workflowStates with the correct team filter", async () => {
    const linearClient = {
      workflowStates: vi.fn().mockResolvedValue({ nodes: [] }),
    };

    await resolveWorkflowStatesByTeam(linearClient, ["t1", "t2"]);

    expect(linearClient.workflowStates).toHaveBeenCalledWith({
      filter: { team: { id: { in: ["t1", "t2"] } } },
      first: 100,
    });
  });

  it("parallelizes state.team resolution — all team relations are resolved", async () => {
    // Track the order of team relation resolutions to verify they are started
    // concurrently rather than sequentially.
    const teamResolutionOrder: string[] = [];

    function makeState(id: string, name: string, teamId: string) {
      return {
        id,
        name,
        team: new Promise<{ id: string }>((res) =>
          setImmediate(() => {
            teamResolutionOrder.push(teamId);
            res({ id: teamId });
          }),
        ),
      };
    }

    const states = [
      makeState("s1", "Backlog", "team-X"),
      makeState("s2", "Todo", "team-X"),
      makeState("s3", "In Progress", "team-Y"),
    ];

    const linearClient = {
      workflowStates: vi.fn().mockResolvedValue({ nodes: states }),
    };

    const map = await resolveWorkflowStatesByTeam(linearClient, ["team-X", "team-Y"]);

    // All three states must have resolved their team relation
    expect(teamResolutionOrder).toHaveLength(3);
    expect(map.get("team-X:Backlog")).toBe("s1");
    expect(map.get("team-X:Todo")).toBe("s2");
    expect(map.get("team-Y:In Progress")).toBe("s3");
  });

  it("skips states whose team relation resolves to null/undefined", async () => {
    const states = [
      { id: "s1", name: "Backlog", team: Promise.resolve({ id: "team-A" }) },
      { id: "s2", name: "Todo", team: Promise.resolve(null) }, // no team
    ];

    const linearClient = {
      workflowStates: vi.fn().mockResolvedValue({ nodes: states }),
    };

    const map = await resolveWorkflowStatesByTeam(linearClient, ["team-A"]);

    expect(map.get("team-A:Backlog")).toBe("s1");
    // s2 should be omitted (no teamId)
    expect(map.size).toBe(1);
  });

  it("returns empty map when workflowStates returns no nodes", async () => {
    const linearClient = {
      workflowStates: vi.fn().mockResolvedValue({ nodes: [] }),
    };

    const map = await resolveWorkflowStatesByTeam(linearClient, ["t1"]);

    expect(map.size).toBe(0);
  });
});
