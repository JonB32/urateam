import { describe, it, expect } from "vitest";
import {
  buildTriageV1Prompt,
  buildTriageV2Prompt,
  isV2Disabled,
} from "../pm/actions/triage-prompt.js";

const FIXTURE_ISSUE = {
  identifier: "BEC-100",
  title: "Login throws 500 on empty email",
  description:
    "When the email field is empty, POST /auth/login returns 500 instead of 400.",
};
const identitySanitize = (s: string) => s;

describe("buildTriageV1Prompt — pure refactor of the v1 inline prompt", () => {
  it("contains the v1 instruction preamble", () => {
    const prompt = buildTriageV1Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toContain(
      "Classify this software issue, generate acceptance criteria",
    );
  });

  it("includes issue identifier, title, and sanitized description", () => {
    const prompt = buildTriageV1Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toContain("Issue: BEC-100");
    expect(prompt).toContain("Title: Login throws 500 on empty email");
    expect(prompt).toContain(
      "Description: When the email field is empty",
    );
  });

  it("includes the Tier 4 DESIGN DOC instructions (regression — must still ship)", () => {
    const prompt = buildTriageV1Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toContain("Tier 4 — DESIGN DOC fields:");
    expect(prompt).toContain("approachSummary:");
    expect(prompt).toContain("openQuestions:");
    expect(prompt).toContain("antiAcceptanceCriteria:");
  });

  it("matches a canonical snapshot", () => {
    expect(buildTriageV1Prompt(FIXTURE_ISSUE, identitySanitize)).toMatchSnapshot();
  });
});

describe("buildTriageV2Prompt — Tier 6a structured prompt", () => {
  it("opens with role + audience priming inside <role> tags", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toMatch(/<role>[\s\S]*senior engineer[\s\S]*<\/role>/);
    expect(prompt).toContain("downstream Claude coding agent");
  });

  it("contains XML-delineated sections for role, output_format, examples, issue, reasoning", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toMatch(/<role>/);
    expect(prompt).toMatch(/<output_format>/);
    expect(prompt).toMatch(/<examples>/);
    expect(prompt).toMatch(/<issue>/);
    expect(prompt).toMatch(/<reasoning>/);
  });

  it("includes multishot examples for each pipeline label (auto-implement, bug, quick-fix, needs-design)", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toMatch(/auto-implement/);
    expect(prompt).toMatch(/bug/);
    expect(prompt).toMatch(/quick-fix/);
    expect(prompt).toMatch(/needs-design/);
  });

  it("includes at least one anti-example (type=\"anti-example\")", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toMatch(/type="anti-example"/);
  });

  it("instructs the model that examples are reference, not output", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt.toLowerCase()).toContain("reference examples");
    expect(prompt.toLowerCase()).toContain("not your output");
  });

  it("ends with the JSON prefill anchor (single open brace)", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt.trimEnd().endsWith("{")).toBe(true);
  });

  it("documents the five new Tier 6b output fields in <output_format>", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    expect(prompt).toMatch(/assumptions/);
    expect(prompt).toMatch(/examples/);
    expect(prompt).toMatch(/affectedFiles/);
    expect(prompt).toMatch(/testStrategy/);
    expect(prompt).toMatch(/riskAssessment/);
  });

  it("includes issue identifier, title, and sanitized description inside the real <issue> block (after <examples>)", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    // The multishot examples block also contains <issue> tags — match the
    // LAST occurrence to get the real issue block.
    const matches = [...prompt.matchAll(/<issue>([\s\S]*?)<\/issue>/g)];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const realIssueBlock = matches[matches.length - 1]![1];
    expect(realIssueBlock).toContain("BEC-100");
    expect(realIssueBlock).toContain("Login throws 500 on empty email");
    expect(realIssueBlock).toContain("empty");
  });

  it("prefix (everything before <issue>) stays under 15000 characters", () => {
    const prompt = buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize);
    const issueIdx = prompt.indexOf("<issue>");
    expect(issueIdx).toBeGreaterThan(0);
    const prefix = prompt.slice(0, issueIdx);
    expect(prefix.length).toBeLessThan(15000);
  });

  it("matches a canonical snapshot", () => {
    expect(buildTriageV2Prompt(FIXTURE_ISSUE, identitySanitize)).toMatchSnapshot();
  });
});

describe("isV2Disabled — env-var escape hatch", () => {
  it("returns false when env var is unset", () => {
    expect(isV2Disabled({})).toBe(false);
  });

  it('returns true only on strict equality with "true"', () => {
    expect(isV2Disabled({ URATEAM_DISABLE_TRIAGE_V2: "true" })).toBe(true);
  });

  it("returns false on any other truthy-looking value", () => {
    expect(isV2Disabled({ URATEAM_DISABLE_TRIAGE_V2: "1" })).toBe(false);
    expect(isV2Disabled({ URATEAM_DISABLE_TRIAGE_V2: "yes" })).toBe(false);
    expect(isV2Disabled({ URATEAM_DISABLE_TRIAGE_V2: "TRUE" })).toBe(false);
    expect(isV2Disabled({ URATEAM_DISABLE_TRIAGE_V2: "" })).toBe(false);
    expect(isV2Disabled({ URATEAM_DISABLE_TRIAGE_V2: "false" })).toBe(false);
  });

  it("reads from process.env by default", () => {
    const orig = process.env.URATEAM_DISABLE_TRIAGE_V2;
    try {
      process.env.URATEAM_DISABLE_TRIAGE_V2 = "true";
      expect(isV2Disabled()).toBe(true);
      process.env.URATEAM_DISABLE_TRIAGE_V2 = "false";
      expect(isV2Disabled()).toBe(false);
    } finally {
      if (orig === undefined) {
        delete process.env.URATEAM_DISABLE_TRIAGE_V2;
      } else {
        process.env.URATEAM_DISABLE_TRIAGE_V2 = orig;
      }
    }
  });
});
