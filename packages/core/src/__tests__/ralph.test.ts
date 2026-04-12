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

  it("returns satisfied on agent error (fail-open)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        throw new Error("SDK error");
      })(),
    );

    const result = await checkRequirements(issue, makeHandoff(), "/tmp");
    expect(result.satisfied).toBe(true);
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
