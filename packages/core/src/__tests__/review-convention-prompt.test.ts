/**
 * Tier 2 — convention-checklist review prompt.
 *
 * The review-stage prompt is augmented with a 9-category project-convention
 * checklist drawn from CLAUDE.md. The review agent uses these categories
 * verbatim in its `ReviewFinding[]` output, so the existing draft-PR /
 * review-fix loop machinery picks them up as blocking findings just like
 * the security categories.
 *
 * This test verifies the prompt assembly contains every category by name,
 * the categories list in REVIEW_OUTPUT_FORMAT is exhaustive, and the
 * checklist text itself is non-empty.
 */
import { describe, it, expect } from "vitest";
import { reviewTemplate } from "../executor/prompt/templates.js";
import {
  PROJECT_CONVENTION_CHECKLIST,
  REVIEW_OUTPUT_FORMAT,
} from "../security/review-checklist.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

const TIER_2_CATEGORIES = [
  "scratch-files",
  "db-ddl-drift",
  "audit-bypass-undocumented",
  "credential-in-interface",
  "spec-vs-impl",
  "convention-execfile",
  "convention-console",
  "convention-throw",
  "convention-as-any",
] as const;

const stubIssue: SanitizedIssue = {
  id: "BEC-999",
  slug: "test-issue",
  title: "test issue",
  description: "fixture",
  acceptanceCriteria: [],
  labels: ["auto-implement"],
  priority: 0,
};

const stubRepo: RepoConfig = {
  url: "https://example.invalid/repo.git",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
  provider: "github",
};

describe("PROJECT_CONVENTION_CHECKLIST — exported and non-empty", () => {
  it("is a non-empty string", () => {
    expect(typeof PROJECT_CONVENTION_CHECKLIST).toBe("string");
    expect(PROJECT_CONVENTION_CHECKLIST.length).toBeGreaterThan(200);
  });

  it("mentions all 9 Tier 2 categories by exact name", () => {
    for (const cat of TIER_2_CATEGORIES) {
      expect(
        PROJECT_CONVENTION_CHECKLIST,
        `category "${cat}" must be named verbatim in the checklist`,
      ).toContain(cat);
    }
  });

  it("names the failure modes the autonomous pipeline has actually shipped (PR #258 scratch files, PR #254 spec-vs-impl, etc.)", () => {
    // These are contextual references the brief calls out — anchor the
    // checklist to real incidents so the agent has explicit framing.
    expect(PROJECT_CONVENTION_CHECKLIST).toMatch(/scratch|FINAL_|TESTING_|TEST_/);
    expect(PROJECT_CONVENTION_CHECKLIST).toMatch(/execFile/);
    expect(PROJECT_CONVENTION_CHECKLIST).toMatch(/createLogger|console\.log/);
    expect(PROJECT_CONVENTION_CHECKLIST).toMatch(/failPipeline|throw/);
    expect(PROJECT_CONVENTION_CHECKLIST).toMatch(/AnyDb|as any/);
  });
});

describe("REVIEW_OUTPUT_FORMAT — enumerates the new categories", () => {
  it("lists every Tier 2 category in the allowed-values block", () => {
    for (const cat of TIER_2_CATEGORIES) {
      expect(
        REVIEW_OUTPUT_FORMAT,
        `category "${cat}" must be listed as a valid value in REVIEW_OUTPUT_FORMAT`,
      ).toContain(cat);
    }
  });
});

describe("reviewTemplate — assembles the convention checklist into the prompt", () => {
  it("includes PROJECT_CONVENTION_CHECKLIST verbatim", () => {
    const prompt = reviewTemplate(stubIssue, stubRepo);
    expect(prompt).toContain(PROJECT_CONVENTION_CHECKLIST);
  });

  it("includes every Tier 2 category name", () => {
    const prompt = reviewTemplate(stubIssue, stubRepo);
    for (const cat of TIER_2_CATEGORIES) {
      expect(prompt, `category "${cat}" must appear in the assembled prompt`).toContain(cat);
    }
  });

  it("still includes SECURITY_REVIEW_CHECKLIST (additive, not replacement)", () => {
    const prompt = reviewTemplate(stubIssue, stubRepo);
    expect(prompt).toContain("SQL injection");
    expect(prompt).toContain("XSS");
  });
});
