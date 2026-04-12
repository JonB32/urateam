/**
 * BEC-99: Cross-worktree contamination guard for parallel agent dispatches
 *
 * This file started as a reproduction test that documented the gaps allowing
 * cross-branch contamination when multiple agents are dispatched in parallel
 * against different branches that share the same underlying git repository
 * clone (via `git worktree`).
 *
 * The gaps identified were:
 *
 * 1. `autoCommitChanges()` had no branch-safety guard — it committed to
 *    whatever HEAD the worktree was currently on.
 *
 * 2. `createWorktree()` uses `git worktree add -B <branch>` which RESETS the
 *    branch ref to the current HEAD if the branch already exists.  In a race
 *    where two runs share the same branch name (e.g. a retry after a
 *    stale-worktree removal), the second call clobbers the first's commits.
 *
 * 3. No pre-push git hook existed to validate that the worktree's HEAD branch
 *    matched the expected pipeline branch before pushing.
 *
 * 4. CLAUDE.md did not document the shared-.git-directory limitation or safe
 *    patterns for parallel agent dispatch.
 *
 * FIXES (BEC-99):
 * - autoCommitChanges now accepts `expectedBranch` and throws on mismatch
 * - pushBranch / pushBranchForce call verifyBranchMatch before every push
 * - createWorktree installs a pre-push hook via installPrePushHook
 * - Root CLAUDE.md now documents the isolation model and safe patterns
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { createWorktree, autoCommitChanges } from "../../repo/git.js";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Helper: bootstrap a local bare "origin" + a clone from it.
// ---------------------------------------------------------------------------
function makeSharedRepo() {
  const origin = mkdtempSync(join(tmpdir(), "bec99-origin-"));
  const clone = mkdtempSync(join(tmpdir(), "bec99-clone-"));

  execFileSync("git", ["init", "--bare", origin]);
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);

  // Create an initial commit in a temp working copy so origin/main exists.
  const work = mkdtempSync(join(tmpdir(), "bec99-work-"));
  execFileSync("git", ["clone", origin, work]);
  execFileSync("git", ["-C", work, "config", "user.email", "ci@test.com"]);
  execFileSync("git", ["-C", work, "config", "user.name", "CI"]);
  writeFileSync(join(work, "README.md"), "initial\n");
  execFileSync("git", ["-C", work, "add", "README.md"]);
  execFileSync("git", ["-C", work, "commit", "-m", "init"]);
  execFileSync("git", ["-C", work, "push", "origin", "main"]);
  rmSync(work, { recursive: true, force: true });

  // Clone is what the pipeline runner uses as `repoDir`.
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
// FIX 1 — autoCommitChanges now throws when HEAD is on the wrong branch
//
// Before BEC-99: autoCommitChanges had no branch guard and silently committed
// to whatever HEAD the worktree was currently on, causing cross-contamination.
//
// After BEC-99: passing `expectedBranch` makes it throw immediately on mismatch,
// turning the silent data loss into a loud, recoverable error.
// ---------------------------------------------------------------------------
describe("BEC-99 fix 1: autoCommitChanges verifies branch before committing", () => {
  it("throws when HEAD branch does not match expectedBranch", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-runs-"));
    dirs.push(baseDir);

    // ── set up two branches in origin so we can check them out ──────────────
    const prep = mkdtempSync(join(tmpdir(), "bec99-prep-"));
    dirs.push(prep);
    execFileSync("git", ["clone", origin, prep]);
    execFileSync("git", ["-C", prep, "config", "user.email", "ci@test.com"]);
    execFileSync("git", ["-C", prep, "config", "user.name", "CI"]);
    execFileSync("git", ["-C", prep, "checkout", "-b", "agent/BEC-56-cache"]);
    writeFileSync(join(prep, "cache.ts"), "// BEC-56 cache\n");
    execFileSync("git", ["-C", prep, "add", "cache.ts"]);
    execFileSync("git", ["-C", prep, "commit", "-m", "feat(BEC-56): add cache"]);
    execFileSync("git", ["-C", prep, "push", "origin", "agent/BEC-56-cache"]);

    // ── Pipeline creates a worktree for BEC-85 ────────────────────────────
    const bec85WorktreePath = await createWorktree(
      clone,
      "run-bec85",
      "agent/BEC-85-sanitize",
      baseDir,
    );

    // Verify the worktree is on the correct branch.
    const branchBefore = execFileSync("git", ["-C", bec85WorktreePath, "rev-parse", "--abbrev-ref", "HEAD"])
      .toString()
      .trim();
    expect(branchBefore).toBe("agent/BEC-85-sanitize");

    // ── Simulate an agent running `git checkout` inside its own worktree ──
    execFileSync("git", ["-C", clone, "fetch", "origin"]);
    execFileSync("git", ["-C", bec85WorktreePath, "checkout", "agent/BEC-56-cache"]);

    // ── Agent writes a file (BEC-85's work) ──────────────────────────────
    writeFileSync(join(bec85WorktreePath, "sanitize.ts"), "// BEC-85 sanitization fix\n");

    // ── FIX: autoCommitChanges now throws when expectedBranch is provided and mismatched ──
    await expect(
      autoCommitChanges(bec85WorktreePath, "BEC-85", "agent/BEC-85-sanitize"),
    ).rejects.toThrow(/branch mismatch/i);

    // ── The wrong branch received no stray commit ──────────────────────────
    const currentBranch = execFileSync(
      "git", ["-C", bec85WorktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
    ).toString().trim();
    expect(currentBranch).toBe("agent/BEC-56-cache"); // still on wrong branch...
    // ...but no commit was made there:
    const log = execFileSync(
      "git", ["-C", bec85WorktreePath, "log", "--oneline", "-3"],
    ).toString().trim();
    expect(log).not.toContain("BEC-85"); // guard prevented the cross-contamination commit
  });

  it("commits normally when HEAD matches expectedBranch", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-runs-clean-"));
    dirs.push(baseDir);

    const wtPath = await createWorktree(clone, "run-clean", "agent/BEC-99-clean", baseDir);

    writeFileSync(join(wtPath, "fix.ts"), "// clean fix\n");

    // Should succeed — HEAD matches expectedBranch.
    const committed = await autoCommitChanges(wtPath, "BEC-99", "agent/BEC-99-clean");
    expect(committed).toBe(true);

    const log = execFileSync("git", ["-C", wtPath, "log", "--oneline", "-1"]).toString().trim();
    expect(log).toContain("BEC-99");
  });

  it("commits normally when no expectedBranch is provided (backward compatible)", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-runs-compat-"));
    dirs.push(baseDir);

    const wtPath = await createWorktree(clone, "run-compat", "agent/BEC-99-compat", baseDir);
    writeFileSync(join(wtPath, "fix.ts"), "// compat fix\n");

    // No expectedBranch — should work as before (no branch check).
    const committed = await autoCommitChanges(wtPath, "BEC-99");
    expect(committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG 2 — createWorktree with -B resets branch ref in a concurrent scenario
//
// `git worktree add -B <branch>` RESETS the branch pointer to HEAD if the
// branch already exists.  If two pipeline runs race and the second call wins
// after the first has already committed, the first run's commits become
// unreachable (dangling).
//
// NOTE: This remains a known limitation of the git worktree model. The
// contamination guards in BEC-99 (branch verification before commit/push)
// prevent the *symptom* of cross-contaminated pushes, but the underlying
// `-B` ref-reset still occurs on retry/stale-worktree recovery scenarios.
// Callers should avoid reusing the same branch name across concurrent runs.
// ---------------------------------------------------------------------------
describe("BEC-99 bug 2 (known limitation): -B flag in createWorktree resets ref on reuse", () => {
  it("second createWorktree call with -B on same branch name resets ref to HEAD", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-b-runs-"));
    dirs.push(baseDir);

    // ── First worktree for a run ──────────────────────────────────────────
    const wt1 = await createWorktree(clone, "run-1", "agent/BEC-99-shared", baseDir);

    // Agent makes a commit on the branch.
    writeFileSync(join(wt1, "run1.ts"), "// run-1 work\n");
    execFileSync("git", ["-C", wt1, "add", "run1.ts"]);
    execFileSync("git", ["-C", wt1, "commit", "-m", "feat(BEC-99): run-1 commit"]);

    const commitAfterRun1 = execFileSync("git", ["-C", wt1, "rev-parse", "HEAD"])
      .toString().trim();

    // ── First worktree is removed (simulating cleanup or stale-worktree recovery) ──
    execFileSync("git", ["-C", clone, "worktree", "remove", wt1, "--force"]);

    // ── Second run reuses the same branch name (retry / re-run scenario) ──
    const wt2 = await createWorktree(clone, "run-2", "agent/BEC-99-shared", baseDir);

    const commitAfterRun2 = execFileSync("git", ["-C", wt2, "rev-parse", "HEAD"])
      .toString().trim();

    // KNOWN LIMITATION: the branch ref is reset — run-1's commit is orphaned.
    // Mitigation: don't reuse the same branch name across concurrent/retry runs.
    expect(commitAfterRun1).not.toBe(commitAfterRun2);

    let run1CommitReachable = true;
    try {
      execFileSync("git", ["-C", wt2, "merge-base", "--is-ancestor", commitAfterRun1, "HEAD"]);
    } catch {
      run1CommitReachable = false;
    }
    expect(run1CommitReachable).toBe(false); // run-1's work is unreachable from the reset branch
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — createWorktree now installs a pre-push hook
//
// Before BEC-99: no pre-push hook validated branch names before pushing.
// After BEC-99: createWorktree calls installPrePushHook, which writes
//   .git/hooks/pre-push that aborts pushes when HEAD ≠ the remote ref.
// ---------------------------------------------------------------------------
describe("BEC-99 fix 3: pre-push hook is installed by createWorktree", () => {
  it("pre-push hook exists in .git/hooks/ after createWorktree", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-hook-"));
    dirs.push(baseDir);

    await createWorktree(clone, "run-hook-check", "agent/BEC-99-hook-test", baseDir);

    const hookPath = join(clone, ".git", "hooks", "pre-push");
    expect(existsSync(hookPath)).toBe(true); // FIX CONFIRMED: hook is now installed
  });

  it("pre-push hook content validates branch name before push", async () => {
    const { origin, clone } = makeSharedRepo();
    dirs.push(origin, clone);

    const baseDir = mkdtempSync(join(tmpdir(), "bec99-hook-content-"));
    dirs.push(baseDir);

    await createWorktree(clone, "run-hook-content", "agent/BEC-99-hook-content", baseDir);

    const hookPath = join(clone, ".git", "hooks", "pre-push");
    const hookContent = readFileSync(hookPath, "utf8");

    // Hook should reference the contamination guard purpose
    expect(hookContent).toMatch(/Linear Agent Framework/);
    expect(hookContent).toMatch(/branch mismatch/i);
    expect(hookContent).toMatch(/exit 1/);
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — Root CLAUDE.md now documents worktree isolation
//
// Before BEC-99: CLAUDE.md was silent about shared .git, contamination risks,
//   and safe parallel dispatch patterns.
// After BEC-99: root CLAUDE.md documents all of these.
// ---------------------------------------------------------------------------
describe("BEC-99 fix 4: root CLAUDE.md documents worktree isolation model", () => {
  const rootClaudeMdPath = join(
    new URL("../../../../../", import.meta.url).pathname,
    "CLAUDE.md",
  );

  it("root CLAUDE.md documents shared .git directory limitation", () => {
    const content = readFileSync(rootClaudeMdPath, "utf8");

    // These patterns are now present after the BEC-99 fix.
    // Note: the regex uses .* to tolerate markdown backtick/bold formatting.
    expect(content).toMatch(/shared.*\.git/i);
    expect(content).toMatch(/cross.?branch contamination/i);
    expect(content).toMatch(/parallel agent dispatch/i);
    // pre-push hook is mentioned as installPrePushHook or pre-push hook
    expect(content).toMatch(/pre.?push/i);
  });

  it("root CLAUDE.md documents cherry-pick recovery procedure", () => {
    const content = readFileSync(rootClaudeMdPath, "utf8");

    expect(content).toMatch(/cherry.?pick/i);
    expect(content).toMatch(/force.?with.?lease/i);
  });
});
