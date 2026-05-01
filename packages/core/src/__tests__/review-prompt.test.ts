import { describe, it, expect } from "vitest";
import {
  buildReviewPrompt,
  parseReviewFindings,
  estimateTokens,
} from "../executor/review/review-prompt.js";
import type { HandoffArtifact } from "../types.js";

const handoff: HandoffArtifact = {
  runId: "r1",
  issueId: "i1",
  stage: "review",
  timestamp: "2026-04-30T00:00:00Z",
  summary: "",
  filesChanged: ["src/foo.ts"],
  approach: "",
  context: {
    issueIntent: "Fix bug X",
    constraints: ["no new deps"],
    assumptions: ["node 20"],
  },
  tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
};

describe("buildReviewPrompt", () => {
  it("includes intent, constraints, diff, and JSON-output instruction", () => {
    const prompt = buildReviewPrompt({
      handoff,
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n@@\n+x",
      files: [{ path: "src/foo.ts", body: "export const x = 1;" }],
      maxInputTokens: 100_000,
    });
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[0].role).toBe("system");
    expect(prompt.messages[1].role).toBe("user");
    expect(prompt.messages[1].content).toContain("Fix bug X");
    expect(prompt.messages[1].content).toContain("no new deps");
    expect(prompt.messages[1].content).toContain("diff --git");
    expect(prompt.messages[1].content).toContain("export const x = 1;");
    expect(prompt.messages[0].content).toContain("findings");  // schema instruction
    expect(prompt.truncatedFiles).toBe(0);
  });

  it("drops file bodies tail-first when over budget but keeps the diff", () => {
    const big = "x".repeat(20_000);
    const out = buildReviewPrompt({
      handoff,
      diff: "diff --git a/foo b/foo\n+y",
      files: [
        { path: "a.ts", body: big },
        { path: "b.ts", body: big },
        { path: "c.ts", body: big },
      ],
      maxInputTokens: 6_000, // forces truncation
    });
    expect(out.truncatedFiles).toBeGreaterThan(0);
    expect(out.messages[1].content).toContain("diff --git");
  });
});

describe("parseReviewFindings", () => {
  it("extracts the first balanced JSON object and validates against schema", () => {
    const raw = `Sure, here is the review:
\`\`\`json
{ "findings": [
  { "severity": "warning", "file": "a.ts", "line": 1, "category": "x", "description": "d", "fix": "f" }
] }
\`\`\`
End.`;
    const findings = parseReviewFindings(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("warning");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseReviewFindings("not json at all")).toThrow();
  });

  it("throws when schema validation fails", () => {
    expect(() => parseReviewFindings('{"findings":[{"bad":true}]}')).toThrow();
  });
});

describe("estimateTokens", () => {
  it("returns a roughly char/4 estimate", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});
