import { describe, it, expect } from "vitest";
import { implementTemplate } from "../executor/prompt/templates.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

const issue: SanitizedIssue = {
  id: "BEC-X",
  slug: "test-feature",
  title: "test",
  description: "do the thing",
  url: "https://linear.app/test",
  priority: 2,
  labels: [],
  acceptanceCriteria: ["AC1: thing works"],
} as any;

const repo: RepoConfig = {
  url: "https://example.com/repo",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  testCommand: "pnpm test",
} as any;

describe("implementTemplate emits decisions instruction (BEC-227 Phase 4 / Track D)", () => {
  it("standard (non-review-feedback, non-merge-conflict) branch includes <decisions> instruction", () => {
    const out = implementTemplate(issue, repo);
    expect(out).toMatch(/<decisions>/);
    expect(out).toMatch(/decisions/i);
    expect(out).toMatch(/keyFiles/);
    expect(out).toMatch(/leftUnhandled/);
  });

  it("review-feedback branch does NOT include decisions instruction (surgical scope)", () => {
    const out = implementTemplate(issue, repo, undefined, {
      prBranch: "agent/BEC-X-test",
      comments: [],
    } as any);
    expect(out).not.toMatch(/<decisions>/);
  });

  it("merge-conflict branch does NOT include decisions instruction", () => {
    const out = implementTemplate(issue, repo, undefined, undefined, {
      defaultBranch: "main",
    } as any);
    expect(out).not.toMatch(/<decisions>/);
  });
});
