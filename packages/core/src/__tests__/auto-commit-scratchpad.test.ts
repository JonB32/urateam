import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCommitChanges, isScratchpadPath } from "../repo/git.js";

/**
 * BEC-157: pipeline auto-commit must filter agent scratchpad files (e.g.,
 * `.claude/`, root-level `BEC-*-*.md`, `verify-*.{mjs,ts}`) so they don't get
 * pushed to the target repo. The agent has no idea these are local scratchpad;
 * the auto-commit step is the safety gate.
 */

const GIT_AUTHOR = {
  GIT_AUTHOR_NAME: "Test Bot",
  GIT_AUTHOR_EMAIL: "test-bot@example.com",
  GIT_COMMITTER_NAME: "Test Bot",
  GIT_COMMITTER_EMAIL: "test-bot@example.com",
};

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_AUTHOR }, encoding: "utf-8" });
}

function listFilesInLastCommit(repo: string): string[] {
  return git(["show", "--name-only", "--pretty=format:", "HEAD"], repo)
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("autoCommitChanges scratchpad filter (BEC-157)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "urateam-bec157-"));
    git(["init", "--initial-branch=main"], repo);
    git(["config", "user.email", "test-bot@example.com"], repo);
    git(["config", "user.name", "Test Bot"], repo);
    // Create a base commit so HEAD has a parent (autoCommitChanges expects a
    // valid HEAD it can branch-check against; even without that, commits
    // produce nicer diffs against a parent).
    writeFileSync(join(repo, "README.md"), "# initial\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "initial"], repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("commits real source files but excludes .claude/* scratchpad", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "foo.ts"), "export const foo = 1;\n");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), '{"hook":"x"}\n');

    const result = await autoCommitChanges(repo, "BEC-999");

    expect(result).toBe(true);
    const files = listFilesInLastCommit(repo);
    expect(files).toContain("src/foo.ts");
    expect(files).not.toContain(".claude/settings.json");
    // Scratchpad file still exists on disk — just not committed
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(true);
  });

  it("excludes root-level BEC-NNN-*.md scratchpad", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "real.ts"), "export const real = 1;\n");
    writeFileSync(join(repo, "BEC-149-INDEX.md"), "# scratchpad\n");
    writeFileSync(join(repo, "BEC-149-PR-CHECKLIST.md"), "# checklist\n");

    await autoCommitChanges(repo, "BEC-999");

    const files = listFilesInLastCommit(repo);
    expect(files).toContain("src/real.ts");
    expect(files).not.toContain("BEC-149-INDEX.md");
    expect(files).not.toContain("BEC-149-PR-CHECKLIST.md");
  });

  it("excludes root-level verify-*.{mjs,ts,js} scratchpad scripts", async () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "real.ts"), "real\n");
    writeFileSync(join(repo, "verify-fix.mjs"), "// scratchpad\n");
    writeFileSync(join(repo, "verify-thing.ts"), "// scratchpad\n");

    await autoCommitChanges(repo, "BEC-999");

    const files = listFilesInLastCommit(repo);
    expect(files).toContain("src/real.ts");
    expect(files).not.toContain("verify-fix.mjs");
    expect(files).not.toContain("verify-thing.ts");
  });

  it("does NOT exclude legitimate root-level files (CHANGELOG.md, CONTRIBUTING.md, README.md)", async () => {
    writeFileSync(join(repo, "CHANGELOG.md"), "# changelog\n");
    writeFileSync(join(repo, "CONTRIBUTING.md"), "# contrib\n");

    await autoCommitChanges(repo, "BEC-999");

    const files = listFilesInLastCommit(repo);
    expect(files).toContain("CHANGELOG.md");
    expect(files).toContain("CONTRIBUTING.md");
  });

  it("does NOT exclude verify-*.ts inside src/ (only root-level matches)", async () => {
    // Real-world: a developer may legitimately have a `verify-*.ts` in
    // src/utils/ as part of an actual feature. Only root-level scratchpad
    // patterns get filtered.
    mkdirSync(join(repo, "src", "utils"), { recursive: true });
    writeFileSync(join(repo, "src", "utils", "verify-input.ts"), "export {};\n");

    await autoCommitChanges(repo, "BEC-999");

    const files = listFilesInLastCommit(repo);
    expect(files).toContain("src/utils/verify-input.ts");
  });

  it("returns false when ALL changes are scratchpad (nothing real to commit)", async () => {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), '{}\n');
    writeFileSync(join(repo, "BEC-200-OUTPUT.md"), "# x\n");

    const result = await autoCommitChanges(repo, "BEC-999");

    // No real files to commit → returns false (just like an empty status)
    expect(result).toBe(false);
  });

  // BEC-157 safety net (Sonnet review Important #1): if a scratchpad file is
  // ALREADY tracked in HEAD (operator committed it pre-filter), unstaging via
  // `git rm --cached` would record a permanent deletion. Skip the unstage for
  // tracked entries — preserve the file as a normal commit.
  it("preserves tracked scratchpad files instead of silently deleting them", async () => {
    // Operator previously (pre-filter) committed .claude/settings.json
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), "old\n");
    git(["add", "."], repo);
    git(["commit", "-m", "operator committed scratchpad pre-filter"], repo);

    // Now agent modifies it AND adds a real file
    writeFileSync(join(repo, ".claude", "settings.json"), "new\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "real.ts"), "real\n");

    const result = await autoCommitChanges(repo, "BEC-999");

    expect(result).toBe(true);
    const files = listFilesInLastCommit(repo);
    expect(files).toContain("src/real.ts");
    // The tracked .claude/settings.json should still appear as committed
    // (with new content) — NOT deleted from the repo.
    expect(files).toContain(".claude/settings.json");
    // Verify the file is not staged for deletion in HEAD~1..HEAD
    const headContent = git(["show", "HEAD:.claude/settings.json"], repo);
    expect(headContent).toBe("new\n");
  });
});

describe("isScratchpadPath unit tests (BEC-157)", () => {
  // Direct unit tests for the predicate, decoupled from git plumbing.
  // Covers boundary cases that the integration tests don't reach.

  it("matches .claude/ directory and contents", () => {
    expect(isScratchpadPath(".claude")).toBe(true);
    expect(isScratchpadPath(".claude/")).toBe(true);
    expect(isScratchpadPath(".claude/settings.json")).toBe(true);
    expect(isScratchpadPath(".claude/nested/deep.json")).toBe(true);
  });

  it("does NOT match .claude when nested under a directory", () => {
    // Root-anchored: a subproject's .claude dir isn't pipeline scratchpad
    expect(isScratchpadPath("frontend/.claude/x")).toBe(false);
    expect(isScratchpadPath("packages/core/.claude/y")).toBe(false);
  });

  it("matches root-level BEC-NNN-*.md scratchpad", () => {
    expect(isScratchpadPath("BEC-149-INDEX.md")).toBe(true);
    expect(isScratchpadPath("BEC-1-x.md")).toBe(true);
    expect(isScratchpadPath("BEC-9999-foo.md")).toBe(true);
  });

  it("does NOT match BEC-*.md without numeric ID or non-root path", () => {
    expect(isScratchpadPath("BEC-foo.md")).toBe(false); // no numeric prefix
    expect(isScratchpadPath("docs/BEC-149-INDEX.md")).toBe(false); // not at root
    expect(isScratchpadPath("CHANGELOG.md")).toBe(false);
  });

  it("matches root-level verify-*.{mjs,ts,js,cjs} but not without extension", () => {
    expect(isScratchpadPath("verify-fix.mjs")).toBe(true);
    expect(isScratchpadPath("verify-x.ts")).toBe(true);
    expect(isScratchpadPath("verify-y.js")).toBe(true);
    expect(isScratchpadPath("verify-z.cjs")).toBe(true);
    expect(isScratchpadPath("verify.mjs")).toBe(false); // no dash
    expect(isScratchpadPath("verifyutils.mjs")).toBe(false); // no dash
    expect(isScratchpadPath("src/utils/verify-input.ts")).toBe(false); // not at root
  });

  it("matches root-level BEC-NNN-*-VERIFICATION.md but NOT generic *-VERIFICATION.md", () => {
    expect(isScratchpadPath("BEC-149-MIGRATION-VERIFICATION.md")).toBe(true);
    expect(isScratchpadPath("BEC-200-VERIFICATION.md")).toBe(true);
    // Pattern tightened (was overbroad in initial PR; would have filtered these):
    expect(isScratchpadPath("SECURITY-VERIFICATION.md")).toBe(false);
    expect(isScratchpadPath("API-VERIFICATION.md")).toBe(false);
  });

  it("does NOT match legitimate root-level files", () => {
    expect(isScratchpadPath("CHANGELOG.md")).toBe(false);
    expect(isScratchpadPath("CONTRIBUTING.md")).toBe(false);
    expect(isScratchpadPath("README.md")).toBe(false);
    expect(isScratchpadPath("LICENSE")).toBe(false);
    expect(isScratchpadPath("package.json")).toBe(false);
    expect(isScratchpadPath("turbo.json")).toBe(false);
  });
});
