import { describe, it, expect } from "vitest";
import { surgicalReviewFixPrompt } from "../executor/prompt/templates.js";
import type { ReviewFinding, DecisionArtifact } from "../types.js";

const findings: ReviewFinding[] = [
  {
    severity: "blocking",
    category: "correctness",
    file: "packages/core/src/foo.ts",
    line: 42,
    description: "this null-check is wrong; foo can be undefined here",
    fix: "use optional chaining or guard before access",
  },
  {
    severity: "blocking",
    category: "tests",
    file: "packages/core/src/__tests__/foo.test.ts",
    line: 10,
    description: "missing test for the empty-array branch",
    fix: "add a test that passes []",
  },
];

const decisions: DecisionArtifact = {
  decisions: [
    { choice: "use Zod refinement", reason: "preserves error path", alternativesConsidered: [] },
  ],
  leftUnhandled: [],
  keyFiles: ["packages/core/src/types.ts"],
};

describe("surgicalReviewFixPrompt (BEC-227 Phase 4 / Track B)", () => {
  it("includes every finding's description + file + line", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    for (const f of findings) {
      expect(out).toContain(f.description);
      expect(out).toContain(f.file);
      expect(out).toContain(String(f.line));
    }
  });

  it("renders previously-decided context when decisions are present", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    expect(out).toContain("use Zod refinement");
    expect(out).toMatch(/previously decided|previously made|prior decisions/i);
  });

  it("omits the decisions section when decisions are null", () => {
    const out = surgicalReviewFixPrompt(findings, null);
    expect(out).not.toContain("Zod");
    // Findings still present.
    for (const f of findings) {
      expect(out).toContain(f.description);
    }
  });

  it("omits the decisions section when decisions are empty", () => {
    const out = surgicalReviewFixPrompt(findings, {
      decisions: [],
      leftUnhandled: [],
      keyFiles: [],
    });
    expect(out).not.toMatch(/previously decided|previously made|prior decisions/i);
  });

  it("does NOT contain any <previous-stage-context> XML or implement-template boilerplate", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    expect(out).not.toMatch(/<previous-stage-context>/);
    expect(out).not.toMatch(/INTEGRATION REQUIREMENT/);
    expect(out).not.toMatch(/Create a branch named/);
  });

  it("instructs the agent to commit + push but NOT create a new PR", () => {
    const out = surgicalReviewFixPrompt(findings, decisions);
    expect(out).toMatch(/commit/i);
    expect(out).toMatch(/push/i);
    expect(out).toMatch(/do not create|don't create|do NOT create/i);
  });
});
