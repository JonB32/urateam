/**
 * Tier 4 — triage produces a real design doc.
 *
 * The PM Agent's triage prompt is extended to also produce a 3-5 line
 * `approachSummary`, an `openQuestions` array, and an `antiAcceptanceCriteria`
 * array (anti-scope items). When `openQuestions.length > 0`, the ticket is
 * forced to the `needs-design` pipeline label so the await-approval stage
 * gates a human before any implement-stage tokens are spent — same routing
 * mechanism as the QO observer-marker gate.
 *
 * Tests assert the routing decision and the structure of the Linear comment.
 * The Claude SDK call is stubbed via the `callClaude` DI hook the triage
 * function already accepts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { triageNewIssues } from "../pm/actions/triage.js";

interface IssueFixture {
  id: string;
  identifier: string;
  title: string;
  description: string;
  team: { id: string };
}

function mockLinearClient(issues: IssueFixture[]) {
  const updateIssue = vi.fn().mockResolvedValue({ success: true });
  const createComment = vi.fn().mockResolvedValue({ success: true });
  const wrappedIssues = issues.map((i) => ({
    ...i,
    team: Promise.resolve(i.team),
    state: Promise.resolve({ name: "Triage" }),
    labels: () => Promise.resolve({ nodes: [] }),
  }));
  return {
    issues: vi.fn().mockResolvedValue({ nodes: wrappedIssues }),
    issueLabels: vi.fn().mockResolvedValue({
      nodes: [
        { id: "lbl_auto", name: "auto-implement" },
        { id: "lbl_bug", name: "bug" },
        { id: "lbl_qf", name: "quick-fix" },
        { id: "lbl_nd", name: "needs-design" },
      ],
    }),
    updateIssue,
    createComment,
  };
}

const sanitize = (text: string): string => text;

const clearSpec: IssueFixture = {
  id: "iss_clear",
  identifier: "BEC-100",
  title: "Add a foo flag",
  description: "Add a boolean `foo` flag to `BarConfig`. Default to false.",
  team: { id: "team_1" },
};

const ambiguousSpec: IssueFixture = {
  id: "iss_ambig",
  identifier: "BEC-101",
  title: "Improve the thing",
  description: "Make the thing better somehow.",
  team: { id: "team_1" },
};

describe("triage Tier 4 — clear-spec issue routes to normal pipeline (no openQuestions)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes a clear-spec issue to auto-implement (complexity != trivial) when openQuestions is empty", async () => {
    const linearClient = mockLinearClient([clearSpec]);
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 2,
        labels: ["feature"],
        complexity: "small",
        rationale: "clear feature request",
        approachSummary:
          "Add a `foo` boolean to BarConfig schema, default false. Plumb through to where BarConfig is consumed. Add a unit test.",
        openQuestions: [],
        antiAcceptanceCriteria: ["must NOT add new dependencies"],
        acceptanceCriteria: [
          "BarConfig schema in types.ts gains a `foo` boolean field with default false",
          "config/bar.ts reads `config.foo` and branches on it",
          "tests/bar.test.ts asserts both `foo: true` and `foo: false`",
        ],
      }),
    );

    const results = await triageNewIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      callClaude,
      sanitize,
      stateMap: new Map([["team_1:Backlog", "state_backlog"]]),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.issueId).toBe("BEC-100");
    expect(results[0]!.labels).toContain("auto-implement");
    expect(results[0]!.labels).not.toContain("needs-design");
    expect(results[0]!.openQuestions ?? []).toEqual([]);
    expect(results[0]!.approachSummary).toContain("BarConfig");
    expect(results[0]!.antiAcceptanceCriteria).toEqual([
      "must NOT add new dependencies",
    ]);

    const updateCall = linearClient.updateIssue.mock.calls[0]!;
    expect(updateCall[1].labelIds).toContain("lbl_auto");
    expect(updateCall[1].labelIds).not.toContain("lbl_nd");
  });

  it("posts a Linear comment that includes Approach + Anti-acceptance sections (when non-empty)", async () => {
    const linearClient = mockLinearClient([clearSpec]);
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 2,
        labels: ["feature"],
        complexity: "small",
        rationale: "clear feature request",
        approachSummary: "Add field, plumb through, test.",
        openQuestions: [],
        antiAcceptanceCriteria: ["must NOT add new dependencies"],
        acceptanceCriteria: ["BarConfig schema gains foo"],
      }),
    );

    await triageNewIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      callClaude,
      sanitize,
      stateMap: new Map([["team_1:Backlog", "state_backlog"]]),
    });

    const commentCall = linearClient.createComment.mock.calls[0]!;
    const body = commentCall[0].body;
    expect(body).toContain("**Approach (Tier 4):**");
    expect(body).toContain("Anti-acceptance criteria");
    expect(body).toContain("must NOT add new dependencies");
    expect(body).not.toContain("Open questions");
  });
});

describe("triage Tier 4 — ambiguous-spec issue forces needs-design (openQuestions non-empty)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to needs-design when Claude flags open questions, regardless of complexity classification", async () => {
    const linearClient = mockLinearClient([ambiguousSpec]);
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 3,
        labels: ["feature"],
        complexity: "small", // would normally → "auto-implement"
        rationale: "ambiguous — needs clarification",
        approachSummary:
          "Could not formulate a clear approach due to ambiguity. See open questions.",
        openQuestions: [
          "What does 'better' mean — performance, UX, code quality?",
          "Which user-facing surface is in scope?",
        ],
        antiAcceptanceCriteria: [],
        acceptanceCriteria: [],
      }),
    );

    const results = await triageNewIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      callClaude,
      sanitize,
      stateMap: new Map([["team_1:Backlog", "state_backlog"]]),
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.labels).toContain("needs-design");
    expect(results[0]!.labels).not.toContain("auto-implement");
    expect(results[0]!.openQuestions).toHaveLength(2);

    const updateCall = linearClient.updateIssue.mock.calls[0]!;
    expect(updateCall[1].labelIds).toContain("lbl_nd");
  });

  it("posts an Open Questions section in the Linear comment when forced to needs-design", async () => {
    const linearClient = mockLinearClient([ambiguousSpec]);
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 3,
        labels: ["feature"],
        complexity: "small",
        rationale: "ambiguous",
        approachSummary: "TBD pending clarification.",
        openQuestions: ["Which feature does this refer to?"],
        antiAcceptanceCriteria: [],
        acceptanceCriteria: [],
      }),
    );

    await triageNewIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      callClaude,
      sanitize,
      stateMap: new Map([["team_1:Backlog", "state_backlog"]]),
    });

    const commentCall = linearClient.createComment.mock.calls[0]!;
    const body = commentCall[0].body;
    expect(body).toContain("routed to needs-design");
    expect(body).toContain("Open questions (must be answered before implement)");
    expect(body).toContain("Which feature does this refer to?");
    expect(body).toContain("**Pipeline:** needs-design");
  });

  it("trims whitespace-only questions and only fires routing for substantive entries", async () => {
    const linearClient = mockLinearClient([ambiguousSpec]);
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 3,
        labels: ["feature"],
        complexity: "small",
        rationale: "fixture",
        approachSummary: "test approach",
        openQuestions: ["   ", "", "  Real question?  "],
        antiAcceptanceCriteria: [],
        acceptanceCriteria: [],
      }),
    );

    const results = await triageNewIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      callClaude,
      sanitize,
      stateMap: new Map([["team_1:Backlog", "state_backlog"]]),
    });

    expect(results[0]!.openQuestions).toEqual(["Real question?"]);
    expect(results[0]!.labels).toContain("needs-design");
  });

  it("treats missing/undefined openQuestions field as empty (backwards compat with classifier omissions)", async () => {
    const linearClient = mockLinearClient([clearSpec]);
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 2,
        labels: ["feature"],
        complexity: "small",
        rationale: "clear",
        approachSummary: "do the thing",
        // openQuestions and antiAcceptanceCriteria omitted entirely
        acceptanceCriteria: ["criterion 1"],
      }),
    );

    const results = await triageNewIssues({
      linearClient: linearClient as any,
      teamIds: ["team_1"],
      callClaude,
      sanitize,
      stateMap: new Map([["team_1:Backlog", "state_backlog"]]),
    });

    expect(results[0]!.labels).not.toContain("needs-design");
    expect(results[0]!.openQuestions).toBeUndefined();
    expect(results[0]!.antiAcceptanceCriteria).toBeUndefined();
  });
});
