import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Agent SDK before importing the module under test so that any
// "fallback" / "first-resumed" path that would otherwise invoke the Haiku
// validator stays hermetic.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { validateHandoff, type ValidateRunMode } from "../executor/validate.js";
import type { HandoffArtifact, SanitizedIssue, RepoConfig } from "../types.js";
import type { HandoffParseResult } from "../executor/handoff.js";

const issue: SanitizedIssue = {
  id: "BEC-227",
  slug: "test-issue",
  title: "Test issue",
  description: "A test issue for validation runMode",
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
    issueId: "BEC-227",
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
  };
}

describe("validate.ts runMode (BEC-227)", () => {
  beforeEach(async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as ReturnType<typeof vi.fn>).mockClear();
  });

  it("runMode='resumed' → skip validation, return valid+skipped without invoking agent", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const querySpy = query as ReturnType<typeof vi.fn>;

    // Use blank summary + empty filesChanged so the existing fast-path bypass
    // would NOT trigger — only the runMode='resumed' branch can return early.
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true, { filesChanged: [], summary: "" }),
      issue,
      repo,
      "/tmp/test",
      "resumed" satisfies ValidateRunMode,
    );

    expect(result.valid).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("resumed");
    // Agent must NOT have been called.
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("runMode='first-resumed' → validate as before (heuristic fast-path still applies)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const querySpy = query as ReturnType<typeof vi.fn>;

    // Default fixture has filesChanged AND summary so the existing heuristic
    // fast-path returns valid without the runMode='resumed' skip path running.
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true),
      issue,
      repo,
      "/tmp/test",
      "first-resumed" satisfies ValidateRunMode,
    );

    expect(result.valid).toBe(true);
    // skipped flag is only set by the runMode='resumed' branch — heuristic
    // bypass leaves it undefined / falsy.
    expect(result.skipped).toBeFalsy();
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("runMode='fallback' → validate as before (invokes agent when heuristic fails)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const querySpy = query as ReturnType<typeof vi.fn>;
    querySpy.mockReturnValue(
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

    // Empty filesChanged so heuristic fails and agent IS called — this proves
    // 'fallback' is NOT short-circuited by the runMode skip path.
    const result = await validateHandoff(
      "implement",
      makeHandoffResult(true, { filesChanged: [] }),
      issue,
      repo,
      "/tmp/test",
      "fallback" satisfies ValidateRunMode,
    );

    expect(result.valid).toBe(true);
    expect(result.skipped).toBeFalsy();
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});
