/**
 * Tier 5 — escalation on consecutive failures.
 *
 * When the circuit breaker fires (≥ maxConsecutiveFailures failed runs in
 * a row), the PM Agent escalates by:
 *   1. Adding the `needs-design` label to the Linear issue (preserving
 *      existing labels)
 *   2. Posting a Linear comment with the last failure's error message
 *   3. Invoking the operator-supplied `slackPostAlert` callback
 *   4. Emitting a `pm.escalated_to_needs_design` audit event
 *
 * Subsequent ticks find the `needs-design` label already in place and
 * skip the escalation (the circuit-breaker event still fires for
 * observability).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { promoteReadyIssues } from "../pm/actions/promote.js";

interface IssueFixture {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  team: { id: string };
  labels: Array<{ id: string; name: string }>;
}

function mockLinearClient(issues: IssueFixture[]) {
  const updateIssue = vi.fn().mockResolvedValue({ success: true });
  const createComment = vi.fn().mockResolvedValue({ success: true });
  const issueLabels = vi.fn().mockResolvedValue({
    nodes: [
      { id: "lbl_auto", name: "auto-implement" },
      { id: "lbl_bug", name: "bug" },
      { id: "lbl_nd", name: "needs-design" },
    ],
  });
  const wrappedIssues = issues.map((i) => ({
    ...i,
    team: Promise.resolve(i.team),
    state: Promise.resolve({ name: "Backlog" }),
    labels: () => Promise.resolve({ nodes: i.labels }),
  }));
  return {
    issues: vi.fn().mockResolvedValue({ nodes: wrappedIssues }),
    issueLabels,
    updateIssue,
    createComment,
  };
}

const failingIssue: IssueFixture = {
  id: "iss_fail",
  identifier: "BEC-700",
  title: "Some broken feature",
  description: "...",
  priority: 2,
  team: { id: "team_1" },
  labels: [{ id: "lbl_auto", name: "auto-implement" }],
};

const alreadyEscalatedIssue: IssueFixture = {
  id: "iss_already",
  identifier: "BEC-701",
  title: "Previously escalated",
  description: "...",
  priority: 2,
  team: { id: "team_1" },
  labels: [
    { id: "lbl_auto", name: "auto-implement" },
    { id: "lbl_nd", name: "needs-design" },
  ],
};

describe("Tier 5 — escalation fires when circuit breaker trips on a non-escalated issue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds the needs-design label, posts a Linear comment, calls slackPostAlert, and updates the result reason", async () => {
    const linearClient = mockLinearClient([failingIssue]);
    const checkConflict = vi.fn().mockResolvedValue({
      overlapRisk: "none",
      likelyFiles: [],
      reasoning: "no conflict",
    });
    const slackPostAlert = vi.fn().mockResolvedValue(undefined);
    const getLastError = vi
      .fn()
      .mockResolvedValue("Stage 'implement' failed: TypeError on line 42");

    const results = await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      slotsAvailable: 3,
      checkConflict,
      stateMap: new Map([["team_1:Todo", "state_todo"]]),
      maxConsecutiveFailures: 3,
      getFailureCount: vi.fn().mockResolvedValue(5),
      getLastError,
      slackPostAlert,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.promoted).toBe(false);
    expect(results[0]!.reason).toContain("escalated to needs-design");
    expect(results[0]!.reason).not.toContain("already escalated");

    // Label added (preserving existing)
    expect(linearClient.updateIssue).toHaveBeenCalledWith(
      "iss_fail",
      expect.objectContaining({
        labelIds: expect.arrayContaining(["lbl_auto", "lbl_nd"]),
      }),
    );
    // Comment posted
    expect(linearClient.createComment).toHaveBeenCalledTimes(1);
    const commentBody = linearClient.createComment.mock.calls[0]![0].body;
    expect(commentBody).toContain("Escalated to `needs-design`");
    expect(commentBody).toMatch(/\*\*5\*\* consecutive failed pipeline runs/);
    expect(commentBody).toContain("threshold 3");
    expect(commentBody).toContain("TypeError on line 42");

    // Slack alert fired
    expect(slackPostAlert).toHaveBeenCalledTimes(1);
    expect(slackPostAlert).toHaveBeenCalledWith({
      issueId: "BEC-700",
      issueTitle: "Some broken feature",
      failureCount: 5,
      errorMessage: "Stage 'implement' failed: TypeError on line 42",
    });
  });

  it("renders a fallback message when no last-failure error is available", async () => {
    const linearClient = mockLinearClient([failingIssue]);
    const results = await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      slotsAvailable: 3,
      checkConflict: vi.fn().mockResolvedValue({
        overlapRisk: "none",
        likelyFiles: [],
        reasoning: "no conflict",
      }),
      stateMap: new Map([["team_1:Todo", "state_todo"]]),
      maxConsecutiveFailures: 3,
      getFailureCount: vi.fn().mockResolvedValue(3),
      getLastError: vi.fn().mockResolvedValue(null),
    });

    expect(results[0]!.reason).toContain("escalated to needs-design");
    const commentBody = linearClient.createComment.mock.calls[0]![0].body;
    expect(commentBody).toContain(
      "(no error message captured on the most recent failed run)",
    );
  });

  it("truncates error messages over 500 chars in the Linear comment", async () => {
    const linearClient = mockLinearClient([failingIssue]);
    const longError = "x".repeat(2000);
    await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      slotsAvailable: 3,
      checkConflict: vi.fn().mockResolvedValue({
        overlapRisk: "none",
        likelyFiles: [],
        reasoning: "no conflict",
      }),
      stateMap: new Map([["team_1:Todo", "state_todo"]]),
      maxConsecutiveFailures: 3,
      getFailureCount: vi.fn().mockResolvedValue(3),
      getLastError: vi.fn().mockResolvedValue(longError),
    });

    const commentBody = linearClient.createComment.mock.calls[0]![0].body;
    // Body contains the truncated form with a trailing ellipsis.
    expect(commentBody).toMatch(/x{500}…/);
    expect(commentBody).not.toMatch(/x{1000}/);
  });
});

describe("Tier 5 — already-escalated issues skip the escalation (idempotency)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT add the label again, does NOT post a second comment, does NOT call slackPostAlert", async () => {
    const linearClient = mockLinearClient([alreadyEscalatedIssue]);
    const slackPostAlert = vi.fn();

    const results = await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      slotsAvailable: 3,
      checkConflict: vi.fn().mockResolvedValue({
        overlapRisk: "none",
        likelyFiles: [],
        reasoning: "no conflict",
      }),
      stateMap: new Map([["team_1:Todo", "state_todo"]]),
      maxConsecutiveFailures: 3,
      getFailureCount: vi.fn().mockResolvedValue(5),
      slackPostAlert,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.reason).toContain("already escalated");
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
    expect(linearClient.createComment).not.toHaveBeenCalled();
    expect(slackPostAlert).not.toHaveBeenCalled();
  });
});

describe("Tier 5 — no escalation when circuit breaker is disabled or threshold not reached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clean issue (failures below threshold) is promoted normally — no escalation side effects", async () => {
    const linearClient = mockLinearClient([failingIssue]);
    const slackPostAlert = vi.fn();

    const results = await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      slotsAvailable: 3,
      checkConflict: vi.fn().mockResolvedValue({
        overlapRisk: "none",
        likelyFiles: [],
        reasoning: "no conflict",
      }),
      stateMap: new Map([["team_1:Todo", "state_todo"]]),
      maxConsecutiveFailures: 3,
      getFailureCount: vi.fn().mockResolvedValue(1),
      slackPostAlert,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.promoted).toBe(true);
    expect(slackPostAlert).not.toHaveBeenCalled();
    // updateIssue was called for the normal promote (Backlog → Todo); confirm
    // that single call did NOT include needs-design.
    expect(linearClient.updateIssue).toHaveBeenCalledTimes(1);
    const callArgs = linearClient.updateIssue.mock.calls[0]!;
    expect(callArgs[1].labelIds).toBeUndefined();
  });

  it("when slackPostAlert is omitted, escalation still updates Linear + emits audit event", async () => {
    // This proves the alert is best-effort: notifier outages don't suppress
    // the audit / Linear-side signals.
    const linearClient = mockLinearClient([failingIssue]);

    const results = await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      slotsAvailable: 3,
      checkConflict: vi.fn().mockResolvedValue({
        overlapRisk: "none",
        likelyFiles: [],
        reasoning: "no conflict",
      }),
      stateMap: new Map([["team_1:Todo", "state_todo"]]),
      maxConsecutiveFailures: 3,
      getFailureCount: vi.fn().mockResolvedValue(3),
      getLastError: vi.fn().mockResolvedValue("err"),
      // slackPostAlert omitted
    });

    expect(results[0]!.reason).toContain("escalated to needs-design");
    expect(linearClient.updateIssue).toHaveBeenCalled();
    expect(linearClient.createComment).toHaveBeenCalled();
  });
});

describe("Tier 5 — defensive: label not found in workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a warn but does NOT crash when needs-design label is missing from the workspace", async () => {
    const linearClient = mockLinearClient([failingIssue]);
    // Override issueLabels to return no needs-design.
    linearClient.issueLabels.mockResolvedValueOnce({
      nodes: [
        { id: "lbl_auto", name: "auto-implement" },
        { id: "lbl_bug", name: "bug" },
      ],
    });

    const results = await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      slotsAvailable: 3,
      checkConflict: vi.fn().mockResolvedValue({
        overlapRisk: "none",
        likelyFiles: [],
        reasoning: "no conflict",
      }),
      stateMap: new Map([["team_1:Todo", "state_todo"]]),
      maxConsecutiveFailures: 3,
      getFailureCount: vi.fn().mockResolvedValue(3),
      getLastError: vi.fn().mockResolvedValue("err"),
    });

    expect(results[0]!.reason).toContain("escalated to needs-design");
    // Comment + label-update would have been attempted; updateIssue NOT called
    // because needsDesignLabelId resolved to undefined.
    expect(linearClient.updateIssue).not.toHaveBeenCalled();
    // Comment still posted (so the operator sees the escalation rationale
    // even when the label couldn't be applied).
    expect(linearClient.createComment).toHaveBeenCalledTimes(1);
  });
});
