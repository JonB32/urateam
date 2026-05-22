/**
 * Tests for BEC-230: triage should preserve hand-written acceptance criteria
 * instead of regenerating them from scratch with Haiku.
 */
import { describe, it, expect, vi } from "vitest";
import { parseHandWrittenACs, buildTriageV1Prompt, buildTriageV2Prompt } from "../pm/actions/triage-prompt.js";
import { triageNewIssues } from "../pm/actions/triage.js";

// ---------------------------------------------------------------------------
// Unit tests for parseHandWrittenACs
// ---------------------------------------------------------------------------

describe("parseHandWrittenACs", () => {
  it("returns empty array when description is null", () => {
    expect(parseHandWrittenACs(null)).toEqual([]);
  });

  it("returns empty array when description has no AC marker", () => {
    expect(parseHandWrittenACs("Fix the bug. It crashes on login.")).toEqual([]);
  });

  it("parses `- [ ] text` items", () => {
    const desc = [
      "Some preamble.",
      "",
      "**Acceptance Criteria:**",
      "- [ ] First criterion",
      "- [ ] Second criterion",
    ].join("\n");
    expect(parseHandWrittenACs(desc)).toEqual(["First criterion", "Second criterion"]);
  });

  it("parses `- [x] text` checked items", () => {
    const desc = "**Acceptance Criteria:**\n- [x] Already done\n- [ ] Still pending";
    expect(parseHandWrittenACs(desc)).toEqual(["Already done", "Still pending"]);
  });

  it("parses plain `- text` bullets", () => {
    const desc = "**Acceptance Criteria:**\n- Plain bullet one\n- Plain bullet two";
    expect(parseHandWrittenACs(desc)).toEqual(["Plain bullet one", "Plain bullet two"]);
  });

  it("stops at the first non-bullet non-empty line (new section)", () => {
    const desc = [
      "**Acceptance Criteria:**",
      "- [ ] AC one",
      "- [ ] AC two",
      "",
      "**Anti-Acceptance Criteria:**",
      "- Do not change X",
    ].join("\n");
    expect(parseHandWrittenACs(desc)).toEqual(["AC one", "AC two"]);
  });

  it("handles blank lines between items", () => {
    const desc = [
      "**Acceptance Criteria:**",
      "- [ ] First",
      "",
      "- [ ] Second",
    ].join("\n");
    expect(parseHandWrittenACs(desc)).toEqual(["First", "Second"]);
  });

  it("returns empty array when marker present but no items follow", () => {
    expect(parseHandWrittenACs("**Acceptance Criteria:**\n\nSome prose")).toEqual([]);
  });

  it("parses 5 items from the canonical BEC-230 description format", () => {
    const items = [
      "When the issue has the marker, parsed items populate acceptanceCriteria",
      "When no marker is present, fall back to Haiku-generated ACs",
      "Haiku prompt skips AC generation when ACs are pre-supplied",
      "Triage result matches the description so prompts stay in sync",
      "Unit test covers the happy path with mocked Haiku",
    ];
    const desc = [
      "Add observability hooks for Sentry and CloudWatch.",
      "",
      "**Acceptance Criteria:**",
      ...items.map((ac) => `- [ ] ${ac}`),
    ].join("\n");
    expect(parseHandWrittenACs(desc)).toEqual(items);
  });
});

// ---------------------------------------------------------------------------
// Prompt-builder tests: omit acceptanceCriteria when hasPreSuppliedACs=true
// ---------------------------------------------------------------------------

describe("buildTriageV1Prompt with hasPreSuppliedACs", () => {
  const sanitize = (s: string) => s;

  it("includes acceptanceCriteria generation instruction when not pre-supplied", () => {
    const prompt = buildTriageV1Prompt(
      { identifier: "BEC-1", title: "Fix bug", description: "desc" },
      sanitize,
    );
    expect(prompt).toContain("generate acceptance criteria");
    expect(prompt).toContain("acceptanceCriteria");
  });

  it("omits acceptanceCriteria generation instruction when pre-supplied", () => {
    const prompt = buildTriageV1Prompt(
      { identifier: "BEC-1", title: "Fix bug", description: "desc", hasPreSuppliedACs: true },
      sanitize,
    );
    expect(prompt).not.toContain("generate acceptance criteria");
    expect(prompt).not.toContain("acceptanceCriteria");
  });
});

describe("buildTriageV2Prompt with hasPreSuppliedACs", () => {
  const sanitize = (s: string) => s;

  it("includes acceptanceCriteria field in output_format when not pre-supplied", () => {
    const prompt = buildTriageV2Prompt(
      { identifier: "BEC-1", title: "Fix bug", description: "desc" },
      sanitize,
    );
    expect(prompt).toContain("acceptanceCriteria:");
  });

  it("omits acceptanceCriteria field in output_format when pre-supplied", () => {
    const prompt = buildTriageV2Prompt(
      { identifier: "BEC-1", title: "Fix bug", description: "desc", hasPreSuppliedACs: true },
      sanitize,
    );
    expect(prompt).not.toContain("acceptanceCriteria:");
    expect(prompt).toContain("PRE-SUPPLIED");
  });
});

// ---------------------------------------------------------------------------
// Integration test: triageNewIssues preserves hand-written ACs
// ---------------------------------------------------------------------------

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

describe("triageNewIssues — BEC-230 hand-written AC preservation", () => {
  it("uses hand-written ACs verbatim; Haiku-generated ACs are ignored", async () => {
    const HAIKU_GENERATED_ACS = ["Sentry integration works", "CloudWatch logs appear"];

    const client = mockLinearClient([
      {
        id: "issue-bec230",
        identifier: "BEC-230-test",
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
        // Haiku returns DIFFERENT ACs — these should be ignored
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
    // Must use the hand-written ACs, not Haiku's
    expect(results[0].acceptanceCriteria).toEqual(HAND_WRITTEN_ACS);
    expect(results[0].acceptanceCriteria).not.toEqual(HAIKU_GENERATED_ACS);
  });

  it("prompt sent to Haiku omits acceptanceCriteria instruction when ACs pre-supplied", async () => {
    const client = mockLinearClient([
      {
        id: "issue-bec230-prompt",
        identifier: "BEC-230-prompt-test",
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
        approachSummary: "Add hooks",
        openQuestions: [],
        antiAcceptanceCriteria: [],
      }),
    );

    await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: defaultStateMap,
    });

    expect(callClaude).toHaveBeenCalledOnce();
    const promptSent = callClaude.mock.calls[0][0] as string;
    // The prompt must NOT ask Haiku to generate acceptanceCriteria
    expect(promptSent).not.toContain('"acceptanceCriteria"');
  });

  it("falls back to Haiku-generated ACs when description has no AC section", async () => {
    const HAIKU_ACS = ["Add Sentry SDK", "Add CloudWatch SDK"];

    const client = mockLinearClient([
      {
        id: "issue-no-acs",
        identifier: "BEC-230-no-acs",
        title: "Add observability hooks",
        description: "Add observability hooks for Sentry and CloudWatch. No hand-written ACs here.",
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
        acceptanceCriteria: HAIKU_ACS,
        approachSummary: "Add hooks",
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
    // No hand-written ACs → use Haiku's output
    expect(results[0].acceptanceCriteria).toEqual(HAIKU_ACS);

    // The prompt SHOULD ask Haiku for ACs when none are pre-supplied
    const promptSent = callClaude.mock.calls[0][0] as string;
    expect(promptSent).toContain("acceptanceCriteria");
  });
});
