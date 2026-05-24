/**
 * BEC-222: classifyExistingBranch
 *
 * Verifies all three classification outcomes:
 *   1. "active-run"  — DB has a running/queued row for the branch
 *   2. "open-pr"     — no active run but checkOpenPR returns a PR
 *   3. "stale"       — no active run, no open PR
 */

import { describe, it, expect, vi } from "vitest";
import { classifyExistingBranch } from "../pipeline/branch-classifier.js";
import type { RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const repoConfig: RepoConfig = {
  url: "https://github.com/org/repo",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

const branch = "agent/BEC-207-support-oauth-token";

/**
 * Build a minimal mock DB whose `.select().from().where().limit()` chain
 * returns a fixed array of rows.
 */
function makeDb(activeRows: Array<{ id: string }> = []) {
  const limitFn = vi.fn().mockResolvedValue(activeRows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyExistingBranch", () => {
  it('returns "active-run" when DB has a running/queued row for the branch', async () => {
    const db = makeDb([{ id: "run_abc" }]);
    const result = await classifyExistingBranch(repoConfig, branch, db);
    expect(result.state).toBe("active-run");
    expect(result.runId).toBe("run_abc");
  });

  it('returns "active-run" without calling checkOpenPR', async () => {
    const db = makeDb([{ id: "run_xyz" }]);
    const checkOpenPR = vi.fn();
    await classifyExistingBranch(repoConfig, branch, db, { checkOpenPR });
    expect(checkOpenPR).not.toHaveBeenCalled();
  });

  it('returns "open-pr" when no active run but checkOpenPR finds a PR', async () => {
    const db = makeDb([]);
    const prInfo = { prNumber: 42, prUrl: "https://github.com/org/repo/pull/42" };
    const checkOpenPR = vi.fn().mockResolvedValue(prInfo);
    const result = await classifyExistingBranch(repoConfig, branch, db, { checkOpenPR });
    expect(result.state).toBe("open-pr");
    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    expect(checkOpenPR).toHaveBeenCalledWith(repoConfig.url, branch);
  });

  it('returns "stale" when no active run and no open PR', async () => {
    const db = makeDb([]);
    const checkOpenPR = vi.fn().mockResolvedValue(null);
    const result = await classifyExistingBranch(repoConfig, branch, db, { checkOpenPR });
    expect(result.state).toBe("stale");
    expect(result.prNumber).toBeUndefined();
    expect(result.runId).toBeUndefined();
  });

  it('returns "stale" when checkOpenPR throws (fail-open)', async () => {
    const db = makeDb([]);
    const checkOpenPR = vi.fn().mockRejectedValue(new Error("gh not available"));
    const result = await classifyExistingBranch(repoConfig, branch, db, { checkOpenPR });
    expect(result.state).toBe("stale");
  });

  it("passes repoUrl and branch name to checkOpenPR", async () => {
    const db = makeDb([]);
    const checkOpenPR = vi.fn().mockResolvedValue(null);
    const customRepo: RepoConfig = { ...repoConfig, url: "https://github.com/acme/widgets" };
    const customBranch = "agent/BEC-999-custom-feature";
    await classifyExistingBranch(customRepo, customBranch, db, { checkOpenPR });
    expect(checkOpenPR).toHaveBeenCalledWith("https://github.com/acme/widgets", customBranch);
  });
});
