import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { checkRequirements, buildRalphContext } from "../executor/ralph.js";
import type { SanitizedIssue, HandoffArtifact } from "../types.js";
import type { HandoffParseResult } from "../executor/handoff.js";

const issue: SanitizedIssue = {
  id: "BEC-1",
  slug: "test-issue",
  title: "Add user search",
  description: "Add search functionality",
  acceptanceCriteria: [
    "Search endpoint returns results",
    "Results are paginated",
    "Empty query returns 400",
  ],
  labels: ["bug"],
  priority: 2,
};

function makeHandoff(overrides?: Partial<HandoffArtifact>): HandoffParseResult {
  return {
    artifact: {
      runId: "run-1",
      issueId: "BEC-1",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Added search endpoint",
      filesChanged: ["src/search.ts"],
      approach: "Created new endpoint",
      context: { issueIntent: "Add search", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 10 },
      ...overrides,
    },
    structured: true,
  };
}

describe("checkRequirements", () => {
  it("returns satisfied when no acceptance criteria", async () => {
    const noAC = { ...issue, acceptanceCriteria: [] };
    const result = await checkRequirements(noAC, makeHandoff(), "/tmp");
    expect(result.satisfied).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("returns satisfied when agent confirms all criteria met", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          content: [{ type: "text", text: '```json\n{"satisfied": true, "gaps": [], "suggestions": []}\n```' }],
        };
      })(),
    );

    const result = await checkRequirements(issue, makeHandoff(), "/tmp");
    expect(result.satisfied).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it("returns gaps when criteria not met", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          content: [{
            type: "text",
            text: '```json\n{"satisfied": false, "gaps": ["Pagination not implemented", "No 400 for empty query"], "suggestions": ["Add limit/offset params", "Add input validation"]}\n```',
          }],
        };
      })(),
    );

    const result = await checkRequirements(issue, makeHandoff(), "/tmp");
    expect(result.satisfied).toBe(false);
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps[0]).toContain("Pagination");
  });

  // urateam#108 — fail closed on eval failure (was fail-open). The previous
  // behavior masked SDK errors / maxTurns exhaustion as "all requirements
  // satisfied", letting broken eval ship as ready-to-merge PRs.
  it("returns evaluationFailed: true when the agent SDK throws (fail-closed)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        throw new Error("Reached maximum number of turns (6)");
      })(),
    );

    const result = await checkRequirements(issue, makeHandoff(), "/tmp");
    expect(result.satisfied).toBe(false);
    expect(result.evaluationFailed).toBe(true);
    expect(result.evaluationError).toContain("RALPH check agent failed");
    expect(result.evaluationError).toContain("Reached maximum number of turns");
    expect(result.gaps).toEqual([]); // no fake gaps invented
  });

  it("returns evaluationFailed: true when agent emits no parseable JSON block", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          content: [{ type: "text", text: "I think it looks fine." }],
        };
      })(),
    );

    const result = await checkRequirements(issue, makeHandoff(), "/tmp");
    expect(result.satisfied).toBe(false);
    expect(result.evaluationFailed).toBe(true);
    expect(result.evaluationError).toContain("no parseable structured output");
  });

  it("does NOT mark evaluationFailed when agent legitimately returns satisfied: false with gaps", async () => {
    // Negative-control: a genuine "agent ran successfully and found gaps"
    // case must not get flagged as eval failure.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          content: [{
            type: "text",
            text: '```json\n{"satisfied": false, "gaps": ["Missing pagination"], "suggestions": []}\n```',
          }],
        };
      })(),
    );

    const result = await checkRequirements(issue, makeHandoff(), "/tmp");
    expect(result.satisfied).toBe(false);
    // Tighter than toBeFalsy() — the success-path contract is that the
    // field is absent entirely, not just falsy. Catches regressions where
    // someone adds `evaluationFailed: false` on every return out of misplaced
    // defensive habit (which would still pass toBeFalsy but break narrowing).
    expect(result.evaluationFailed).toBeUndefined();
    expect(result.gaps).toEqual(["Missing pagination"]);
  });
});

describe("buildRalphContext", () => {
  it("includes iteration number, gaps, and suggestions", () => {
    const check = {
      satisfied: false,
      gaps: ["Missing pagination", "No error handling"],
      suggestions: ["Add limit/offset", "Return 400 on bad input"],
    };
    const handoff = makeHandoff().artifact;

    const context = buildRalphContext(1, check, handoff);

    expect(context).toContain("iteration 1");
    expect(context).toContain("Missing pagination");
    expect(context).toContain("No error handling");
    expect(context).toContain("Add limit/offset");
    expect(context).toContain("Do NOT start from scratch");
  });
});
