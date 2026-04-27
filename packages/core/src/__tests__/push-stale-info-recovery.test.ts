import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pushBranchForce } from "../repo/git.js";

/**
 * Fixture mirroring the reproduction context for urateam#115:
 *
 *   - A bare "origin" repo (acts as the remote).
 *   - A local clone with `origin` configured + a checked-out feature branch.
 *   - The local clone's `refs/remotes/origin/<branch>` points at a commit
 *     that is no longer present on the bare origin (simulating "branch
 *     was deleted from origin between runs").
 *
 * This is the exact state that produces the `force-with-lease` "stale
 * info" rejection in the rotulus#17 OSS validation rerun.
 */
async function makeOriginAndCloneWithStaleTrackingRef(): Promise<{
  originDir: string;
  cloneDir: string;
  branch: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "push-stale-test-"));
  const originDir = join(root, "origin.git");
  const cloneDir = join(root, "clone");
  const branch = "agent/iss-1";

  // 1. Build a bare origin with a baseline commit on main.
  execFileSync("git", ["init", "--bare", "-b", "main", originDir], { stdio: "pipe" });

  // 2. Build a worker clone, push baseline, and push the agent branch.
  const seedDir = join(root, "seed");
  execFileSync("git", ["clone", originDir, seedDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: seedDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: seedDir, stdio: "pipe" });
  await writeFile(join(seedDir, "README.md"), "init\n");
  execFileSync("git", ["add", "."], { cwd: seedDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: seedDir, stdio: "pipe" });
  execFileSync("git", ["push", "origin", "main"], { cwd: seedDir, stdio: "pipe" });
  execFileSync("git", ["checkout", "-b", branch], { cwd: seedDir, stdio: "pipe" });
  await writeFile(join(seedDir, "feature.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: seedDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "feat: agent work"], { cwd: seedDir, stdio: "pipe" });
  execFileSync("git", ["push", "origin", branch], { cwd: seedDir, stdio: "pipe" });

  // 3. Build the actual clone the test will operate on. Mirrors what the
  //    runner has after a previous run pushed.
  execFileSync("git", ["clone", "--branch", branch, originDir, cloneDir], { stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: cloneDir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: cloneDir, stdio: "pipe" });

  // 4. DELETE the agent branch from origin (simulating: operator closed
  //    the PR with --delete-branch). Local clone's tracking ref is now
  //    stale — it still points at the deleted commit.
  execFileSync("git", ["push", "origin", "--delete", branch], { cwd: seedDir, stdio: "pipe" });

  // 5. Stage a NEW commit on top of the agent branch in the test clone
  //    (mirrors the new run's work).
  await writeFile(join(cloneDir, "feature.ts"), "export const a = 2; // updated\n");
  execFileSync("git", ["add", "."], { cwd: cloneDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "fix: agent rerun work"], { cwd: cloneDir, stdio: "pipe" });

  await rm(seedDir, { recursive: true, force: true });
  return { originDir, cloneDir, branch };
}

describe("pushBranchForce — stale-info recovery (urateam#115)", () => {
  let setup: { originDir: string; cloneDir: string; branch: string };

  beforeEach(async () => {
    setup = await makeOriginAndCloneWithStaleTrackingRef();
  });

  afterEach(async () => {
    // Clean both fixture dirs (they're under the same root).
    await rm(setup.originDir, { recursive: true, force: true });
    await rm(setup.cloneDir, { recursive: true, force: true });
  });

  it("recovers from 'stale info' rejection by fetching+pruning and retrying", async () => {
    // Sanity check: bare `git push --force-with-lease` would fail here.
    let bareErr: string | null = null;
    try {
      execFileSync(
        "git",
        ["push", "origin", setup.branch, "--force-with-lease"],
        { cwd: setup.cloneDir, stdio: "pipe" },
      );
    } catch (e) {
      bareErr = (e as { stderr?: Buffer }).stderr?.toString() ?? String(e);
    }
    expect(bareErr).toContain("stale info");

    // Real test: pushBranchForce should auto-recover.
    await pushBranchForce(setup.cloneDir, setup.branch);

    // Verify the push actually landed on origin.
    const remoteRefs = execFileSync(
      "git",
      ["ls-remote", "origin", `refs/heads/${setup.branch}`],
      { cwd: setup.cloneDir },
    ).toString();
    expect(remoteRefs).toContain(setup.branch);
  });

  it("propagates non-stale-info push errors instead of swallowing them", async () => {
    // Negative control: a push error that's NOT "stale info" must reach
    // the caller. Trigger one by pointing origin at a non-existent path.
    execFileSync(
      "git",
      ["remote", "set-url", "origin", "/nonexistent/origin.git"],
      { cwd: setup.cloneDir, stdio: "pipe" },
    );
    await expect(
      pushBranchForce(setup.cloneDir, setup.branch),
    ).rejects.toThrow();
  });
});
