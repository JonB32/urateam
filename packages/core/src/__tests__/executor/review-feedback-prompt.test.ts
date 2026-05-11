import { describe, it, expect } from "vitest";
import { implementTemplate } from "../../executor/prompt/templates.js";

const baseIssue = { id: "BEC-999", identifier: "BEC-999", title: "T", description: "D", priority: 3, labels: [], slug: "bec-999-t" } as any;
const baseRepo = { url: "https://github.com/x/y", defaultBranch: "main", testCommand: "pnpm test", buildCommand: "pnpm build" } as any;

describe("implementTemplate — review-feedback prompt (BEC-182)", () => {
  const feedback = {
    prBranch: "agent/BEC-999-foo",
    prUrl: "https://github.com/x/y/pull/42",
    comments: [{ author: "reviewer", body: "rename foo to bar", file: "src/x.ts", line: 12, createdAt: "2026-05-08T00:00:00Z" }],
  } as any;

  it("includes the bounded-scope language", () => {
    const out = implementTemplate(baseIssue, baseRepo, undefined, feedback);
    expect(out).toMatch(/Address ONLY the listed comments/);
    expect(out).toMatch(/Do NOT refactor adjacent code/);
  });

  it("instructs the agent to read the diff first", () => {
    const out = implementTemplate(baseIssue, baseRepo, undefined, feedback);
    expect(out).toMatch(/git diff origin\/main\.\.\.HEAD/);
  });

  it("makes build/test conditional on text-only changes", () => {
    const out = implementTemplate(baseIssue, baseRepo, undefined, feedback);
    expect(out).toMatch(/Skip build\/test ONLY if every change is text-only/);
  });

  it("instructs the agent to stop and report rather than spelunk on failure", () => {
    const out = implementTemplate(baseIssue, baseRepo, undefined, feedback);
    expect(out).toMatch(/stop and report what blocks the resolution/);
  });

  it("review-feedback implement prompt instructs agent to emit context.addressedComments", () => {
    const out = implementTemplate(baseIssue, baseRepo, undefined, feedback);
    expect(out).toContain("context.addressedComments");
    expect(out).toContain("commentId");
    expect(out).toContain("response");
  });
});
