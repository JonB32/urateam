import { describe, it, expect, vi } from "vitest";

// Mock the Agent SDK before importing the module under test
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { validateHandoff } from "../executor/validate.js";
import type { HandoffArtifact, SanitizedIssue, RepoConfig } from "../types.js";
import type { HandoffParseResult } from "../executor/handoff.js";

const issue: SanitizedIssue = {
  id: "BEC-1",
  slug: "test-issue",
  title: "Test issue",
  description: "A test issue for validation",
  acceptanceCriteria: ["Tests pass"],
  labels: ["bug"],
  priority: 2,
};

const repo: RepoConfig = {
  url: "https://github.com/org/repo",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

function makeHandoff(overrides?: Partial<HandoffArtifact>): HandoffArtifact {
  return {
    runId: "run-1",
    issueId: "BEC-1",
    stage: "implement",
    timestamp: new Date().toISOString(),
    summary: "Implemented the feature",
    filesChanged: ["src/index.ts"],
    approach: "Added a new function",
    context: {
      issueIntent: "Add feature",
      constraints: [],
      assumptions: [],
    },
    tokenBudget: {
      contextTokensUsed: 1000,
      recommendedMaxTurns: 10,
    },
    ...overrides,
  };
}

function makeHandoffResult(
  structured: boolean,
  overrides?: Partial<HandoffArtifact>,
): HandoffParseResult {
  return {
    artifact: makeHandoff(overrides),
    structured,
    decisions: null,
  };
}

describe("validateHandoff", () => {
  it("passes unstructured handoffs with a warning (already flagged)", async () => {
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(false),
      issue,
      repo,
      "/tmp/test",
    );
    expect(result.valid).toBe(true);
    expect(result.issues[0]).toContain("validation skipped");
  });

  it("skips agent call when heuristic pre-check passes (files + summary present)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const querySpy = query as ReturnType<typeof vi.fn>;
    querySpy.mockClear();

    // Default fixture has filesChanged and summary — heuristic should pass
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true),
      issue,
      repo,
      "/tmp/test",
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    // Agent should NOT have been called
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("returns valid when validator confirms the handoff (empty filesChanged forces agent)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          content: [
            {
              type: "text",
              text: '```json\n{"valid": true, "issues": []}\n```',
            },
          ],
        };
      })(),
    );

    // Empty filesChanged so heuristic fails and agent is called
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true, { filesChanged: [] }),
      issue,
      repo,
      "/tmp/test",
    );
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("returns invalid when validator finds problems (empty filesChanged forces agent)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          content: [
            {
              type: "text",
              text: '```json\n{"valid": false, "issues": ["src/index.ts does not exist", "Summary claims tests pass but no tests were run"]}\n```',
            },
          ],
        };
      })(),
    );

    // Empty filesChanged so heuristic fails and agent is called
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true, { filesChanged: [] }),
      issue,
      repo,
      "/tmp/test",
    );
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toContain("does not exist");
  });

  it("handles validator producing no structured output (blank summary forces agent)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        yield {
          type: "assistant",
          content: [{ type: "text", text: "I could not validate this." }],
        };
      })(),
    );

    // Blank summary so heuristic fails and agent is called
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true, { summary: "" }),
      issue,
      repo,
      "/tmp/test",
    );
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toContain("did not produce structured output");
  });

  it("treats SDK errors as non-blocking (returns valid with warning)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(
      (async function* () {
        throw new Error("SDK connection failed");
      })(),
    );

    // Empty filesChanged so heuristic fails and agent is called (and throws)
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true, { filesChanged: [] }),
      issue,
      repo,
      "/tmp/test",
    );
    // Infra failure should not block the pipeline
    expect(result.valid).toBe(true);
    expect(result.issues[0]).toContain("Validation skipped due to error");
  });
});
