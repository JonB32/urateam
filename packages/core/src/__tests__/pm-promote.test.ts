import { describe, it, expect, vi } from "vitest";
import { promoteReadyIssues } from "../pm/actions/promote.js";
import { createDb } from "../db/client.js";
import { circuitBreakerState } from "../db/schema.js";

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

    it("promotes matching candidates while skipping unmatched ones in a mixed list", async () => {
      const issues = [
        {
          id: "i1", identifier: "BEC-700", title: "skip me 1", description: "",
          priority: 1, labels: { nodes: [{ name: "marketing" }] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-700",
        },
        {
          id: "i2", identifier: "BEC-701", title: "promote me", description: "",
          priority: 1, labels: { nodes: [{ name: "quick-fix" }] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-701",
        },
        {
          id: "i3", identifier: "BEC-702", title: "skip me 2", description: "",
          priority: 1, labels: { nodes: [] },
          team: { id: "team-1" }, url: "https://linear.app/BEC-702",
        },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 5,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        requirePipelineLabel: true,
        pipelineConfigs: { "quick-fix": pipelineConfig("quick-fix") },
      });

      expect(results).toHaveLength(3);
      const promoted = results.filter((r) => r.promoted);
      expect(promoted).toHaveLength(1);
      expect(promoted[0].issueId).toBe("BEC-701");
      // The two unmatched candidates produce skip-results; updateIssue should
      // only have fired for the matched one.
      expect(client.updateIssue).toHaveBeenCalledTimes(1);
      expect(client.updateIssue).toHaveBeenCalledWith("i2", expect.objectContaining({ stateId: "state-todo" }));
      // Conflict check only runs on the promoted candidate, not on the skipped ones.
      expect(conflictChecker).toHaveBeenCalledTimes(1);
    });
  });

  describe("circuit breaker (BEC-161)", () => {
    /**
     * The promote action must short-circuit candidates whose pipeline keeps
     * failing. We don't need a real DB here — a stub `db` whose query helper
     * returns the expected failure count per-issue is enough to prove promote
     * consults the count and skips when it exceeds the threshold.
     *
     * Plumbing: promote receives `db` + `maxConsecutiveFailures` and an
     * injectable `getFailureCount` (so tests don't need real db rows).
     */

    it("skips candidate with N+ consecutive failed runs (default N=3)", async () => {
      const issues = [
        { id: "i1", identifier: "BEC-161-A", title: "Doom-looping", description: "", priority: 2,
          labels: { nodes: [] }, team: { id: "team-1" }, url: "https://linear.app/BEC-161-A" },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });
      const getFailureCount = vi.fn().mockResolvedValue(3);

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        maxConsecutiveFailures: 3,
        getFailureCount,
      });

      expect(results).toHaveLength(1);
      expect(results[0].promoted).toBe(false);
      expect(results[0].reason).toMatch(/circuit.breaker/i);
      expect(client.updateIssue).not.toHaveBeenCalled();
      // breaker check happens BEFORE expensive conflict-detection
      expect(conflictChecker).not.toHaveBeenCalled();
      expect(getFailureCount).toHaveBeenCalledWith("BEC-161-A");
    });

    it("promotes candidate with fewer than N consecutive failures", async () => {
      const issues = [
        { id: "i1", identifier: "BEC-161-B", title: "Recently failed once", description: "", priority: 2,
          labels: { nodes: [] }, team: { id: "team-1" }, url: "https://linear.app/BEC-161-B" },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });
      const getFailureCount = vi.fn().mockResolvedValue(2);

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        maxConsecutiveFailures: 3,
        getFailureCount,
      });

      expect(results[0].promoted).toBe(true);
      expect(client.updateIssue).toHaveBeenCalled();
    });

    it("breaker disabled when maxConsecutiveFailures is undefined (back-compat)", async () => {
      const issues = [
        { id: "i1", identifier: "BEC-161-C", title: "Has 99 failures", description: "", priority: 2,
          labels: { nodes: [] }, team: { id: "team-1" }, url: "https://linear.app/BEC-161-C" },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });
      const getFailureCount = vi.fn().mockResolvedValue(99);

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        // maxConsecutiveFailures intentionally omitted
        getFailureCount,
      });

      expect(results[0].promoted).toBe(true);
      // breaker not invoked → getFailureCount must not be called
      expect(getFailureCount).not.toHaveBeenCalled();
    });

    it("bypasses the breaker skip for issues in probeOverrideIds (BEC-236)", async () => {
      const issues = [
        { id: "i1", identifier: "BEC-161-A", title: "Doom-looping", description: "", priority: 2,
          labels: { nodes: [] }, team: { id: "team-1" }, url: "https://linear.app/BEC-161-A" },
      ];
      const client = mockLinearClient(issues);
      const conflictChecker = vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" });
      const getFailureCount = vi.fn().mockResolvedValue(3);

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: conflictChecker,
        stateMap: defaultStateMap,
        maxConsecutiveFailures: 3,
        getFailureCount,
        probeOverrideIds: new Set(["BEC-161-A"]),
      });

      // The issue is circuit-broken (3 >= 3) but in probeOverrideIds, so it
      // should be promoted rather than skipped.
      expect(results).toHaveLength(1);
      expect(results[0].promoted).toBe(true);
      expect(results[0].issueId).toBe("BEC-161-A");
      expect(client.updateIssue).toHaveBeenCalledWith("i1", expect.objectContaining({ stateId: "state-todo" }));
      expect(getFailureCount).toHaveBeenCalledWith("BEC-161-A");
    });

    it("inserts a circuit_breaker_state row when Tier-5 escalates (BEC-236)", async () => {
      // Use a real in-memory DB so we can assert the row was written.
      const db = await createDb({ connectionString: ":memory:" });

      const issues = [
        {
          id: "i-bec236",
          identifier: "BEC-236-T",
          title: "Doom-looping issue",
          description: "",
          priority: 2,
          // No needs-design label — so Tier-5 escalation fires.
          labels: { nodes: [] },
          team: { id: "team-1" },
          url: "https://linear.app/BEC-236-T",
        },
      ];

      // mockLinearClient doesn't add issueLabels; add it manually so the
      // needs-design label-lookup inside the escalation block can resolve.
      const client = {
        ...mockLinearClient(issues),
        issueLabels: vi.fn().mockResolvedValue({ nodes: [] }),
      };

      const results = await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" }),
        stateMap: defaultStateMap,
        maxConsecutiveFailures: 3,
        // Inject stub so we don't need real pipeline_runs rows.
        getFailureCount: vi.fn().mockResolvedValue(3),
        getLastError: vi.fn().mockResolvedValue("something broke"),
        db: db as any,
      });

      // Issue is circuit-broken and has no needs-design label → escalation fires.
      expect(results).toHaveLength(1);
      expect(results[0]!.promoted).toBe(false);
      expect(results[0]!.reason).toMatch(/escalated to needs-design/i);

      // The Tier-5 escalation block must have inserted a circuit_breaker_state row.
      const stateRows = await (db as any).select().from(circuitBreakerState);
      expect(stateRows).toHaveLength(1);
      expect(stateRows[0].issueId).toBe("BEC-236-T");
      expect(stateRows[0].escalatedAt).toBeTruthy();
    });

    it("does not insert a second circuit_breaker_state row on re-escalation (idempotent)", async () => {
      const db = await createDb({ connectionString: ":memory:" });

      // Pre-insert a row as if a prior tick already escalated this issue.
      await (db as any)
        .insert(circuitBreakerState)
        .values({ issueId: "BEC-236-U", escalatedAt: new Date() });

      const issues = [
        {
          id: "i-bec236u",
          identifier: "BEC-236-U",
          title: "Already escalated issue",
          description: "",
          priority: 2,
          // needs-design label is already on the issue (alreadyEscalated = true).
          labels: { nodes: [{ id: "lbl-nd", name: "needs-design" }] },
          team: { id: "team-1" },
          url: "https://linear.app/BEC-236-U",
        },
      ];

      const client = {
        ...mockLinearClient(issues),
        issueLabels: vi.fn().mockResolvedValue({ nodes: [] }),
      };

      await promoteReadyIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        slotsAvailable: 1,
        checkConflict: vi.fn().mockResolvedValue({ overlapRisk: "none", likelyFiles: [], reasoning: "" }),
        stateMap: defaultStateMap,
        maxConsecutiveFailures: 3,
        getFailureCount: vi.fn().mockResolvedValue(3),
        getLastError: vi.fn().mockResolvedValue(null),
        db: db as any,
      });

      // Only the original row should exist — the already-escalated gate
      // (alreadyEscalated=true) prevents a second insert.
      const stateRows = await (db as any).select().from(circuitBreakerState);
      expect(stateRows).toHaveLength(1);
    });
  });
});
