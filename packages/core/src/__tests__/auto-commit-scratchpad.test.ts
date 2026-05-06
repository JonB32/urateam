import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCommitChanges } from "../repo/git.js";

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
});
