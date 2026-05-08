import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createWorktree, getCurrentBranch } from "../repo/git.js";

/**
 * Fixture that mirrors the runner's clone-then-worktree flow. Returns a
 * "shared" repo dir that holds the .git data and a baseline commit.
 */
async function makeBareIshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stale-worktree-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  await writeFile(join(dir, "README.md"), "init\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("createWorktree — stale-worktree recovery (urateam#112)", () => {
  let repoDir: string;
  let baseDir: string;

  beforeEach(async () => {
    repoDir = await makeBareIshRepo();
    baseDir = await mkdtemp(join(tmpdir(), "stale-worktree-runs-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  it("first call creates the worktree cleanly", async () => {
    const wt = await createWorktree(repoDir, "run-1", "agent/iss-1", baseDir);
    expect(existsSync(wt)).toBe(true);
    expect(wt).toContain("run-1");
    // BEC-179: worktree must NOT be in detached HEAD state
    const branch = await getCurrentBranch(wt);
    expect(branch).toBe("agent/iss-1");
  });

  it("recovers from 'already checked out' (worktree still on disk)", async () => {
    // First run creates the worktree — branch is "currently checked out".
    const firstWt = await createWorktree(repoDir, "run-1", "agent/iss-1", baseDir);
    expect(existsSync(firstWt)).toBe(true);

    // Second run on the SAME branch, different runId. Without recovery,
    // git rejects with "fatal: '<branch>' is already checked out at '<path>'".
    const secondWt = await createWorktree(repoDir, "run-2", "agent/iss-1", baseDir);
    expect(existsSync(secondWt)).toBe(true);
    expect(secondWt).toContain("run-2");
    // The first worktree should have been removed during recovery.
    expect(existsSync(firstWt)).toBe(false);
    // BEC-179: recovered worktree must NOT be in detached HEAD state
    const branch = await getCurrentBranch(secondWt);
    expect(branch).toBe("agent/iss-1");
  });

  it("recovers from 'already used by worktree' (worktree dir deleted out from under git)", async () => {
    // Reproduces the exact rotulus#17-style failure. First run creates
    // a worktree, then the worktree directory is rm-rf'd WITHOUT
    // running `git worktree prune`. This leaves the branch ↔ worktree
    // association in .git/worktrees/ but no on-disk worktree.
    //
    // git's error wording for THIS case:
    //   "fatal: '<branch>' is already used by worktree at '<path>'"
    // (different from "already checked out" which fires when the dir
    // still exists). Pre-#112 the recovery branch missed this wording.
    const firstWt = await createWorktree(repoDir, "run-1", "agent/iss-1", baseDir);
    expect(existsSync(firstWt)).toBe(true);

    // Rip the worktree dir without telling git about it.
    await rm(firstWt, { recursive: true, force: true });
    expect(existsSync(firstWt)).toBe(false);

    // Sanity check: at this point a bare `git worktree add` produces
    // the "already used by worktree" error.
    let bareAddErr: string | null = null;
    try {
      execFileSync(
        "git",
        ["worktree", "add", "-B", "agent/iss-1", join(baseDir, "sanity", "worktree")],
        { cwd: repoDir, stdio: "pipe" },
      );
    } catch (e) {
      bareAddErr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
    }
    expect(bareAddErr).toContain("already used by worktree");

    // Now the real test: createWorktree should auto-recover.
    const secondWt = await createWorktree(repoDir, "run-2", "agent/iss-1", baseDir);
    expect(existsSync(secondWt)).toBe(true);
    expect(secondWt).toContain("run-2");
    // BEC-179: recovered worktree must NOT be in detached HEAD state.
    // `git rev-parse --abbrev-ref HEAD` returns "HEAD" for detached HEAD.
    const branch = await getCurrentBranch(secondWt);
    expect(branch).toBe("agent/iss-1");
  });

  it("propagates unrelated git errors instead of swallowing them", async () => {
    // Negative control: a git error that's NOT a stale-worktree case
    // must still reach the caller. Trigger one by passing an invalid
    // branch character that the SAFE_BRANCH_RE will accept but git
    // will reject (e.g., a leading dash to make it look like a flag).
    // We use an invalid PATH instead — pointing baseDir at a file
    // (not a directory) which makes `git worktree add` fail with a
    // distinct error.
    const filePath = join(baseDir, "not-a-dir");
    await writeFile(filePath, "blocking file");
    await expect(
      createWorktree(repoDir, "run-fail", "agent/blocked", filePath),
    ).rejects.toThrow();
  });
});
