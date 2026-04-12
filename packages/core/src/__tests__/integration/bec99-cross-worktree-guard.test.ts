/**
 * BEC-99: Integration tests for cross-worktree contamination guard.
 *
 * These tests verify that the BEC-99 fixes (branch verification before
 * commit/push, pre-push hook installation) prevent cross-branch contamination
 * when 3+ agents are dispatched in parallel on different branches that share
 * the same git clone directory.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  createWorktree,
  autoCommitChanges,
  verifyBranchMatch,
  getCurrentBranch,
  installPrePushHook,
} from "../../repo/git.js";

// ---------------------------------------------------------------------------
// Helper: bootstrap a local bare "origin" + a clone from it.
// ---------------------------------------------------------------------------
function makeSharedRepo() {
  const origin = mkdtempSync(join(tmpdir(), "bec99-int-origin-"));
  const clone = mkdtempSync(join(tmpdir(), "bec99-int-clone-"));

  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const work = mkdtempSync(join(tmpdir(), "bec99-int-work-"));
  execFileSync("git", ["clone", origin, work]);
  execFileSync("git", ["-C", work, "config", "user.email", "ci@test.com"]);
  execFileSync("git", ["-C", work, "config", "user.name", "CI"]);
  writeFileSync(join(work, "README.md"), "initial\n");
  execFileSync("git", ["-C", work, "add", "README.md"]);
  execFileSync("git", ["-C", work, "commit", "-m", "init"]);
  execFileSync("git", ["-C", work, "push", "origin", "main"]);
  rmSync(work, { recursive: true, force: true });

  execFileSync("git", ["clone", origin, clone]);
  execFileSync("git", ["-C", clone, "config", "user.email", "ci@test.com"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "CI"]);

  return { origin, clone };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration test: 3 agents dispatched in parallel on different branches
// ---------------------------------------------------------------------------
describe("BEC-99 integration: parallel agent dispatch — commit isolation", () => {
  it("3 parallel agents on different branches keep commits isolated", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-parallel-"));
    dirs.push(baseDir);

    // ── Create 3 worktrees in parallel (as the agent SDK would) ──────────
    const branches = [
      "agent/BEC-101-feature-a",
      "agent/BEC-102-feature-b",
      "agent/BEC-103-feature-c",
    ];

    const [wt1, wt2, wt3] = await Promise.all(
      branches.map((branch, i) =>
        createWorktree(clone, `run-${i + 1}`, branch, baseDir),
      ),
    );
    const worktrees = [wt1, wt2, wt3];

    // ── Verify each worktree starts on the correct branch ────────────────
    for (let i = 0; i < branches.length; i++) {
      const current = await getCurrentBranch(worktrees[i]);
      expect(current).toBe(branches[i]);
    }

    // ── Each agent writes and commits its own file ──────────────────────
    const agentFiles = ["feature-a.ts", "feature-b.ts", "feature-c.ts"];
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(worktrees[i], agentFiles[i]), `// ${branches[i]} work\n`);
    }

    // ── autoCommitChanges with expectedBranch succeeds for all ──────────
    await Promise.all(
      branches.map((branch, i) =>
        autoCommitChanges(worktrees[i], branch.split("/")[1], branch),
      ),
    );

    // ── Verify each branch has exactly the right commit ──────────────────
    for (let i = 0; i < 3; i++) {
      const log = execFileSync(
        "git", ["-C", worktrees[i], "log", "--oneline", "-5"],
      ).toString().trim();
      const branchId = branches[i].split("/")[1]; // e.g. "BEC-101-feature-a"

      // The commit message contains this branch's ID
      expect(log).toContain(branchId);

      // The commit does NOT contain the other branches' IDs
      for (let j = 0; j < 3; j++) {
        if (j !== i) {
          const otherId = branches[j].split("/")[1];
          expect(log).not.toContain(otherId);
        }
      }

      // Verify the branch is still correct
      const current = await getCurrentBranch(worktrees[i]);
      expect(current).toBe(branches[i]);
    }
  });

  it("cross-contamination attempt is blocked by verifyBranchMatch", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-guard-"));
    dirs.push(baseDir);

    const branchA = "agent/BEC-104-alpha";
    const branchB = "agent/BEC-105-beta";

    // Create both worktrees.
    const [wtA, wtB] = await Promise.all([
      createWorktree(clone, "run-alpha", branchA, baseDir),
      createWorktree(clone, "run-beta", branchB, baseDir),
    ]);

    // Simulate agent A's worktree HEAD drifting onto a third branch
    // (not branchB — git prevents checking out a branch already in another worktree).
    // This represents the real-world scenario where an agent ran `git checkout`
    // to some other branch, causing its HEAD to drift away from the expected branch.
    const driftBranch = "agent/BEC-999-drift";
    execFileSync("git", ["-C", wtA, "checkout", "-b", driftBranch]);

    // Agent A writes its file (BEC-104's work) but HEAD is now on the drift branch
    writeFileSync(join(wtA, "alpha-work.ts"), "// alpha's work\n");

    // verifyBranchMatch throws immediately — HEAD is not on branchA
    await expect(
      verifyBranchMatch(wtA, branchA),
    ).rejects.toThrow(/branch mismatch/i);

    // autoCommitChanges with expectedBranch also throws
    await expect(
      autoCommitChanges(wtA, "BEC-104", branchA),
    ).rejects.toThrow(/branch mismatch/i);

    // Branch B (and the drift branch) should NOT contain any commit from agent A
    const logB = execFileSync(
      "git", ["-C", wtB, "log", "--oneline", "-5"],
    ).toString().trim();
    expect(logB).not.toContain("BEC-104");

    // Drift branch also has no stray commit (autoCommitChanges was blocked)
    const logDrift = execFileSync(
      "git", ["-C", wtA, "log", "--oneline", "-5"],
    ).toString().trim();
    expect(logDrift).not.toContain("BEC-104");
  });

  it("verifyBranchMatch is a no-op when HEAD matches expected branch", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-noop-"));
    dirs.push(baseDir);

    const branch = "agent/BEC-106-noop";
    const wt = await createWorktree(clone, "run-noop", branch, baseDir);

    // Should not throw when branch is correct
    await expect(verifyBranchMatch(wt, branch)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration test: installPrePushHook is idempotent
// ---------------------------------------------------------------------------
describe("BEC-99 integration: installPrePushHook idempotency", () => {
  it("calling installPrePushHook multiple times does not corrupt the hook", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    // First install
    await installPrePushHook(clone);
    const { readFile } = await import("node:fs/promises");
    const hookPath = join(clone, ".git", "hooks", "pre-push");
    const contentAfterFirst = await readFile(hookPath, "utf8");

    // Second install — should be idempotent
    await installPrePushHook(clone);
    const contentAfterSecond = await readFile(hookPath, "utf8");

    expect(contentAfterFirst).toBe(contentAfterSecond);
    expect(contentAfterFirst).toMatch(/Linear Agent Framework/);
    expect(contentAfterFirst).toMatch(/exit 0/);
  });

  it("does not overwrite a pre-existing third-party pre-push hook", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const { writeFile, mkdir, chmod } = await import("node:fs/promises");
    const hooksDir = join(clone, ".git", "hooks");
    await mkdir(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-push");
    const thirdPartyHook = "#!/bin/sh\n# Custom hook by user\nexit 0\n";
    await writeFile(hookPath, thirdPartyHook, "utf8");
    await chmod(hookPath, 0o755);

    // Should not overwrite a third-party hook
    await installPrePushHook(clone);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(hookPath, "utf8");
    expect(content).toBe(thirdPartyHook); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Integration test: getCurrentBranch
// ---------------------------------------------------------------------------
describe("BEC-99 integration: getCurrentBranch", () => {
  it("returns the correct branch name for a worktree", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-current-"));
    dirs.push(baseDir);

    const branch = "agent/BEC-107-current";
    const wt = await createWorktree(clone, "run-current", branch, baseDir);

    const current = await getCurrentBranch(wt);
    expect(current).toBe(branch);
  });
});
