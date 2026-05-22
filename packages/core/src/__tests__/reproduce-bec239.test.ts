/**
 * BEC-239 reproduction: getActiveFileMaps is blind to in-flight runs
 * whose branch hasn't been pushed to origin yet.
 *
 * The bug: getActiveFileMaps always diffs origin/<defaultBranch>..origin/<branch>,
 * which throws for runs that haven't pushed yet. The catch falls open to an empty
 * Set — silently treating the in-flight run as touching zero files.
 */

import { describe, it, expect } from "vitest";
import { getActiveFileMaps } from "../pm/conflict.js";

describe("BEC-239 reproduction — getActiveFileMaps blind to in-flight runs", () => {

  /**
   * BUG CASE: run has started but not yet pushed its branch to origin.
   *
   * Expected (after fix): return files from the worktree diff.
   * Actual (before fix):  return empty Set, logs WARN — treating the run as
   *                       touching zero files, so conflict prediction is a no-op
   *                       for this run.
   */
  it("BUG: in-flight run with no remote branch → silently returns empty file set", async () => {
    // Simulate: git rev-parse --verify --quiet origin/<branch> fails (branch not on origin yet)
    // and git diff origin/main..origin/<branch> also fails with "unknown revision"
    const branchNotPushedError = new Error(
      "fatal: ambiguous argument 'origin/main..origin/agent/BEC-238-...': unknown revision or path not in the working tree"
    );

    const execGit = async (args: string[], _cwd: string): Promise<string> => {
      if (args[0] === "fetch") return "";
      // All diff/rev-parse calls for this branch fail — it has no origin ref
      throw branchNotPushedError;
    };

    const fileMaps = await getActiveFileMaps({
      activeRuns: [{ issueId: "BEC-238", branch: "agent/BEC-238-slack-bot-token" }],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    // BUG: empty set returned instead of worktree files
    const files = fileMaps.get("BEC-238")!;
    expect(files).toBeDefined();
    expect(files.size).toBe(0); // <-- THIS IS THE BUG: should be non-empty from worktree
  });

  /**
   * BUG CASE: ActiveRun has no worktreePath field, so there is no way for
   * getActiveFileMaps to fall back to the worktree even if the code tried to.
   *
   * This confirms the structural gap: the interface doesn't carry the worktree path.
   */
  it("BUG: ActiveRun interface has no worktreePath field — worktree fallback is structurally impossible", () => {
    // Compile-time check: the ActiveRun type from conflict.ts has no worktreePath
    // If this test compiles, the field is absent.
    const run: import("../pm/conflict.js").ActiveRun = {
      issueId: "BEC-238",
      branch: "agent/BEC-238-slack-bot-token",
      // worktreePath: "/home/ura/data/runs/<runId>/worktree",  // <-- would be a TS error
    };

    // @ts-expect-error worktreePath does not exist on ActiveRun — this is the structural gap
    const _ = (run as any).worktreePath;

    // The field simply doesn't exist — fix must add it
    expect(Object.keys(run)).not.toContain("worktreePath");
  });

  /**
   * BUG CASE: "not pushed yet" and "genuine git error" are indistinguishable.
   *
   * Both go to the same catch block → both log WARN + return empty Set.
   * The fix must distinguish them: use git rev-parse --verify first, then
   * downgrade the "not pushed" case to debug.
   */
  it("BUG: genuine git error and 'not pushed yet' produce identical outcomes", async () => {
    let warnCount = 0;

    // Patch: simulate what the existing code does on ANY thrown error
    const execGit = async (args: string[], _cwd: string): Promise<string> => {
      if (args[0] === "fetch") return "";
      throw new Error("some-internal-git-error");
    };

    const fileMaps = await getActiveFileMaps({
      activeRuns: [{ issueId: "BEC-99", branch: "agent/BEC-99-some-branch" }],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    // Both cases return empty set — correct for genuine errors, wrong for "not pushed yet"
    expect(fileMaps.get("BEC-99")).toEqual(new Set());
    // The existing code has no mechanism to call worktree diff instead
  });

  /**
   * POSITIVE CASE (should remain working after fix):
   * Run whose branch IS already on origin → existing origin-diff path.
   */
  it("pushed run → correctly reads files from origin diff (existing behavior to preserve)", async () => {
    const execGit = async (args: string[], _cwd: string): Promise<string> => {
      if (args[0] === "fetch") return "";
      if (args.join(" ").includes("origin/main..origin/agent/BEC-237")) {
        return "packages/core/src/pm/slack.ts\npackages/core/src/pm/scheduler.ts\n";
      }
      return "";
    };

    const fileMaps = await getActiveFileMaps({
      activeRuns: [{ issueId: "BEC-237", branch: "agent/BEC-237-some-feature" }],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    expect(fileMaps.get("BEC-237")).toEqual(
      new Set(["packages/core/src/pm/slack.ts", "packages/core/src/pm/scheduler.ts"])
    );
  });

});
