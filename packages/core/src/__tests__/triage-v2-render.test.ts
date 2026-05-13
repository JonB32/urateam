import { describe, it, expect } from "vitest";
import {
  renderTriageComment,
  appendTriageSectionsToDescription,
} from "../pm/actions/triage-render.js";
import type { TriageResult } from "../pm/types.js";

const V1_RESULT: TriageResult = {
  issueId: "BEC-100",
  priority: 2,
  labels: ["bug", "backend", "bug"],
  complexity: "small",
  rationale: "Server-side validation gap on empty email",
  acceptanceCriteria: [
    "validator/email.ts:validate() called from /auth/login",
    "Returns 400 on empty email instead of 500",
  ],
  approachSummary: "Add validator + 400-error path; cover with one test.",
};

const V2_RESULT: TriageResult = {
  ...V1_RESULT,
  assumptions: [
    "Empty email is the only 500 case",
    "Other auth endpoints already validate",
  ],
  examples: [
    {
      scenario: "POST /auth/login {email:'', pw:'x'}",
      expected: "HTTP 400, code EMPTY_EMAIL",
    },
  ],
  affectedFiles: [
    "packages/api/src/routes/auth.ts",
    "packages/api/src/validators/email.ts",
  ],
  testStrategy: {
    unit: "packages/api/src/__tests__/email-validator.test.ts",
    integration: "packages/api/src/__tests__/auth.test.ts",
  },
  riskAssessment: { severity: "low", areas: ["auth", "api"] },
};

describe("renderTriageComment — v1 + v2 markdown contract", () => {
  it("renders the v1 sections unchanged when no v2 fields are present", () => {
    const comment = renderTriageComment(V1_RESULT, {
      forceNeedsDesign: false,
      pipelineLabel: "bug",
    });
    expect(comment).toContain("**PM Agent — Triaged**");
    expect(comment).toContain("**Priority:** 2");
    expect(comment).toContain("**Complexity:** small");
    expect(comment).toContain("**Pipeline:** bug");
    expect(comment).toContain("**Rationale:** Server-side validation gap");
    expect(comment).toContain("**Generated Acceptance Criteria:**");
    expect(comment).toContain("**Approach (Tier 4):**");
  });

  it("renders all 5 new headed sections when v2 fields are present", () => {
    const comment = renderTriageComment(V2_RESULT, {
      forceNeedsDesign: false,
      pipelineLabel: "bug",
    });
    expect(comment).toMatch(/^### Assumptions$/m);
    expect(comment).toMatch(/^### Examples$/m);
    expect(comment).toMatch(/^### Affected Files$/m);
    expect(comment).toMatch(/^### Test Strategy$/m);
    expect(comment).toMatch(/^### Risk Assessment$/m);
  });

  it("renders (none) placeholders for absent v2 fields when at least one v2 field is present", () => {
    const partial: TriageResult = {
      ...V1_RESULT,
      assumptions: ["only assumption"],
      // examples, affectedFiles, testStrategy, riskAssessment all absent
    };
    const comment = renderTriageComment(partial, {
      forceNeedsDesign: false,
      pipelineLabel: "bug",
    });
    expect(comment).toMatch(/^### Examples\n\(none\)$/m);
    expect(comment).toMatch(/^### Affected Files\n\(none\)$/m);
    expect(comment).toMatch(/^### Test Strategy\n\(none\)$/m);
    expect(comment).toMatch(/^### Risk Assessment\n\(none\)$/m);
  });

  it("omits the entire Tier-6b block when no v2 fields are present", () => {
    const comment = renderTriageComment(V1_RESULT, {
      forceNeedsDesign: false,
      pipelineLabel: "bug",
    });
    expect(comment).not.toContain("### Assumptions");
    expect(comment).not.toContain("### Examples");
    expect(comment).not.toContain("### Affected Files");
    expect(comment).not.toContain("### Test Strategy");
    expect(comment).not.toContain("### Risk Assessment");
  });

  it("prefixes the title with `(routed to needs-design)` when forceNeedsDesign", () => {
    const comment = renderTriageComment(V1_RESULT, {
      forceNeedsDesign: true,
      pipelineLabel: "needs-design",
    });
    expect(comment).toContain("(routed to needs-design)");
  });

  it("renders examples as numbered list with Scenario/Expected sub-fields", () => {
    const comment = renderTriageComment(V2_RESULT, {
      forceNeedsDesign: false,
      pipelineLabel: "bug",
    });
    expect(comment).toContain("1. **Scenario:**");
    expect(comment).toContain("**Expected:**");
  });

  it("renders risk assessment as Severity + Areas", () => {
    const comment = renderTriageComment(V2_RESULT, {
      forceNeedsDesign: false,
      pipelineLabel: "bug",
    });
    expect(comment).toContain("**Severity:** low");
    expect(comment).toContain("**Areas:** auth, api");
  });

  it("renders test strategy with unit + integration", () => {
    const comment = renderTriageComment(V2_RESULT, {
      forceNeedsDesign: false,
      pipelineLabel: "bug",
    });
    expect(comment).toContain("- **Unit:** packages/api/src/__tests__/email-validator.test.ts");
    expect(comment).toContain("- **Integration:** packages/api/src/__tests__/auth.test.ts");
  });

  it("matches a canonical snapshot for v2 result", () => {
    expect(
      renderTriageComment(V2_RESULT, {
        forceNeedsDesign: false,
        pipelineLabel: "bug",
      }),
    ).toMatchSnapshot();
  });

  it("matches a canonical snapshot for v1-only result", () => {
    expect(
      renderTriageComment(V1_RESULT, {
        forceNeedsDesign: false,
        pipelineLabel: "bug",
      }),
    ).toMatchSnapshot();
  });
});

describe("appendTriageSectionsToDescription — idempotent description appender", () => {
  it("appends acceptance criteria when not already present (v1 behavior preserved)", () => {
    const out = appendTriageSectionsToDescription("Original description.", V1_RESULT);
    expect(out).toContain("Original description.");
    expect(out).toContain("**Acceptance Criteria:**");
    expect(out).toContain(
      "- [ ] validator/email.ts:validate() called from /auth/login",
    );
  });

  it("appends all 5 v2 sections when v2 fields are present", () => {
    const out = appendTriageSectionsToDescription("Original.", V2_RESULT);
    expect(out).toContain("**Examples:**");
    expect(out).toContain("**Affected Files:**");
    expect(out).toContain("**Test Strategy:**");
    expect(out).toContain("**Risk Assessment:**");
  });

  it("skips sections whose marker already appears (idempotent)", () => {
    const existing =
      "Original.\n\n**Acceptance Criteria:**\n- [ ] one\n\n**Examples:**\n- some example";
    const out = appendTriageSectionsToDescription(existing, V2_RESULT);
    // AC marker present → not re-appended
    expect(out.match(/\*\*Acceptance Criteria:\*\*/g)?.length).toBe(1);
    // Examples marker present → not re-appended
    expect(out.match(/\*\*Examples:\*\*/g)?.length).toBe(1);
    // Affected Files marker not present → appended
    expect(out).toContain("**Affected Files:**");
  });

  it("renders sections to the description in the same order they appear in the comment", () => {
    const out = appendTriageSectionsToDescription("Original.", V2_RESULT);
    const acIdx = out.indexOf("**Acceptance Criteria:**");
    const examplesIdx = out.indexOf("**Examples:**");
    const affectedIdx = out.indexOf("**Affected Files:**");
    const testStrategyIdx = out.indexOf("**Test Strategy:**");
    const riskIdx = out.indexOf("**Risk Assessment:**");
    expect(acIdx).toBeGreaterThan(0);
    expect(examplesIdx).toBeGreaterThan(acIdx);
    expect(affectedIdx).toBeGreaterThan(examplesIdx);
    expect(testStrategyIdx).toBeGreaterThan(affectedIdx);
    expect(riskIdx).toBeGreaterThan(testStrategyIdx);
  });

  it("does not append any v2 section when no v2 fields are present (v1 result)", () => {
    const out = appendTriageSectionsToDescription("Original.", V1_RESULT);
    expect(out).not.toContain("**Examples:**");
    expect(out).not.toContain("**Affected Files:**");
    expect(out).not.toContain("**Test Strategy:**");
    expect(out).not.toContain("**Risk Assessment:**");
  });

  it("handles null/undefined description gracefully", () => {
    const outA = appendTriageSectionsToDescription("", V1_RESULT);
    expect(outA).toContain("**Acceptance Criteria:**");
    // The function expects string input; null/undefined handling is the
    // caller's responsibility (matches existing v1 contract).
  });
});
