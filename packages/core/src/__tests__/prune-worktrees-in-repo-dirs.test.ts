/**
 * BEC-180: skip non-git dirs in the worktree-prune sweep.
 *
 * Pre-fix, the runner ran `git worktree prune` on every entry under
 * `repoCloneDir`. Since BEC-174 landed, that includes `.agent-sweep/`,
 * which has no top-level `.git` — every tick logged a `level:50` ERROR.
 *
 * The new helper whitelists by `.git/` presence before pruning.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pruneWorktreesInRepoDirs } from "../repo/git.js";

describe("pruneWorktreesInRepoDirs (BEC-180)", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "prune-base-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("returns empty result when baseDir does not exist", async () => {
    const result = await pruneWorktreesInRepoDirs(join(baseDir, "does-not-exist"));
    expect(result).toEqual({ pruned: [], skipped: [] });
  });

  it("skips a sibling dir that has no .git/ entry", async () => {
    // The BEC-174 sweep dir holds per-repo subdirs but no top-level .git.
    await mkdir(join(baseDir, ".agent-sweep"), { recursive: true });
    await mkdir(join(baseDir, ".agent-sweep", "abc12345"), { recursive: true });

    const result = await pruneWorktreesInRepoDirs(baseDir);
    expect(result.pruned).toEqual([]);
    expect(result.skipped).toContain(".agent-sweep");
  });

  it("prunes only entries that have a top-level .git/ directory", async () => {
    // Real git repo
    const gitDir = join(baseDir, "real-clone");
    await mkdir(gitDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: gitDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: gitDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitDir, stdio: "pipe" });
    await writeFile(join(gitDir, "README"), "x\n");
    execFileSync("git", ["add", "."], { cwd: gitDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: gitDir, stdio: "pipe" });

    // Non-git sibling (the BEC-174 case)
    await mkdir(join(baseDir, "sweep-cache"), { recursive: true });

    // Plain file at base — not a directory, must be skipped silently
    await writeFile(join(baseDir, "stray.txt"), "");

    const result = await pruneWorktreesInRepoDirs(baseDir);
    expect(result.pruned).toEqual(["real-clone"]);
    expect(result.skipped.sort()).toEqual(["stray.txt", "sweep-cache"].sort());
  });

  it("treats .git as a file (submodule / worktree) the same as a directory", async () => {
    // Some git setups (worktrees, submodules) have .git as a regular file
    // pointing at the actual gitdir. We just need it to exist.
    const dir = join(baseDir, "worktree-style");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".git"), "gitdir: /tmp/some-real-gitdir\n");

    const result = await pruneWorktreesInRepoDirs(baseDir);
    expect(result.pruned).toContain("worktree-style");
  });
});
