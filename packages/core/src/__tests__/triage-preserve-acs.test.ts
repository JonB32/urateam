/**
 * Reproduction test for BEC-230.
 *
 * When a Linear issue description already contains a `**Acceptance Criteria:**`
 * section, `triageNewIssues` should use those items verbatim rather than
 * blindly overwriting with whatever Haiku generates.
 *
 * This file DEMONSTRATES THE BUG — all assertions below are expected to FAIL
 * until the fix ships.
 */
import { describe, it, expect, vi } from "vitest";
import { triageNewIssues } from "../pm/actions/triage.js";

const HAND_WRITTEN_ACS = [
  "When the Linear issue description has the marker, parsed items populate acceptanceCriteria directly",
  "When no marker is present, fall back to Haiku-generated ACs",
  "Triage Haiku prompt skips AC generation when ACs are pre-supplied",
  "Triage result's acceptanceCriteria matches the description so prompts stay in sync",
  "New unit test covers the happy path with mocked Haiku",
];

const DESCRIPTION_WITH_ACS = [
  "Add observability hooks for Sentry and CloudWatch.",
  "",
  "**Acceptance Criteria:**",
  ...HAND_WRITTEN_ACS.map((ac) => `- [ ] ${ac}`),
].join("\n");

function mockLinearClient(issues: any[]) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: issues }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
    issueLabels: vi.fn().mockResolvedValue({
      nodes: [
        { id: "lbl-bug", name: "bug" },
        { id: "lbl-feature", name: "feature" },
        { id: "lbl-backend", name: "backend" },
      ],
    }),
  };
}

const defaultStateMap = new Map([["team-1:Backlog", "state-backlog"]]);

describe("BEC-230 reproduction — triage should preserve hand-written ACs", () => {
  it("BUG: triageNewIssues overwrites hand-written ACs with Haiku-generated ones", async () => {
    const HAIKU_GENERATED_ACS = [
      "Sentry integration works",
      "CloudWatch logs appear",
    ];

    const client = mockLinearClient([
      {
        id: "issue-bec230",
        identifier: "BEC-230-repro",
        title: "Add observability hooks",
        description: DESCRIPTION_WITH_ACS,
        labels: { nodes: [] },
        team: { id: "team-1" },
      },
    ]);

    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 2,
        labels: ["feature", "backend"],
        complexity: "medium",
        rationale: "Needs observability",
        // Haiku returns DIFFERENT ACs than what the description contains:
        acceptanceCriteria: HAIKU_GENERATED_ACS,
        approachSummary: "Add hooks for Sentry and CloudWatch",
        openQuestions: [],
        antiAcceptanceCriteria: [],
      }),
    );

    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(1);

    // THE BUG: triage result contains Haiku's ACs, not the operator's hand-written ones.
    // After the fix, this assertion should pass (result uses hand-written ACs).
    expect(results[0].acceptanceCriteria).toEqual(HAND_WRITTEN_ACS);

    // After the fix, Haiku should NOT have been asked to generate ACs
    // (the callClaude mock should either not be called, or called with a prompt
    // that omits the AC generation instruction).
    // For now we just verify the divergence exists:
    expect(results[0].acceptanceCriteria).not.toEqual(HAIKU_GENERATED_ACS);
  });

  it("BUG: implement prompt sees three divergent AC surfaces simultaneously", async () => {
    // Demonstrate the three surfaces: description (hand-written), structured block
    // (Haiku-regenerated), and CRITICAL verify block (same Haiku array).
    // We do this by inspecting the triage result: if acceptanceCriteria !== hand-written items,
    // then templates.ts lines 56-65 and 328-329 will diverge from the description at line 54.

    const HAIKU_ACS = ["Works correctly", "Is implemented"];

    const client = mockLinearClient([
      {
        id: "issue-bec230b",
        identifier: "BEC-230-repro-b",
        title: "Fix login",
        description: DESCRIPTION_WITH_ACS,
        labels: { nodes: [] },
        team: { id: "team-1" },
      },
    ]);

    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 2,
        labels: ["bug", "backend"],
        complexity: "small",
        rationale: "Login broken",
        acceptanceCriteria: HAIKU_ACS,
        openQuestions: [],
        antiAcceptanceCriteria: [],
      }),
    );

    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(1);

    const triageResult = results[0];

    // The description still contains the hand-written ACs verbatim (surface 1).
    // The triage result uses Haiku's ACs (surfaces 2 and 3).
    // These DIVERGE — that's the bug.
    const handWrittenInDescription = HAND_WRITTEN_ACS.every((ac) =>
      DESCRIPTION_WITH_ACS.includes(ac),
    );
    expect(handWrittenInDescription).toBe(true); // hand-written ACs are in the description

    // BUG: triage result has Haiku's ACs, not the hand-written ones
    expect(triageResult.acceptanceCriteria).toEqual(HAIKU_ACS); // currently passes — BUG IS HERE
    expect(triageResult.acceptanceCriteria).not.toEqual(HAND_WRITTEN_ACS); // currently passes — BUG IS HERE
  });
});
