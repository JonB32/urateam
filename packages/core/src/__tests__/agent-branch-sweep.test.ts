import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { sweepStaleAgentBranches } from "../repo/agent-branch-sweep.js";
import { pmAgentBranchSweptEvent } from "../audit/events.js";

function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): string {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: { ...process.env, ...env },
  })
    .toString()
    .trim();
}

async function makeBareRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-sweep-bare-"));
  git(["init", "-b", "main", "--bare"], dir);
  return dir;
}

async function cloneInto(bareUrl: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "agent-sweep-parent-"));
  const cloneDir = join(parent, "clone");
  execFileSync("git", ["clone", bareUrl, cloneDir], { stdio: "pipe" });
  git(["config", "user.email", "test@test.com"], cloneDir);
  git(["config", "user.name", "Test"], cloneDir);
  return cloneDir;
}

async function commitAndPush(
  cloneDir: string,
  branch: string,
  fileName: string,
  dateIso?: string,
): Promise<void> {
  git(["checkout", "main"], cloneDir);
  git(["checkout", "-b", branch], cloneDir);
  await writeFile(join(cloneDir, fileName), "x\n");
  git(["add", "."], cloneDir);
  const env: Record<string, string> = {};
  if (dateIso) {
    env.GIT_AUTHOR_DATE = dateIso;
    env.GIT_COMMITTER_DATE = dateIso;
  }
  git(["commit", "-m", `seed ${branch}`], cloneDir, env);
  git(["push", "origin", branch], cloneDir);
}

describe("sweepStaleAgentBranches", () => {
  let bareRepo: string;
  let cloneDir: string;

  beforeEach(async () => {
    bareRepo = await makeBareRepo();
    cloneDir = await cloneInto(bareRepo);

    // Initial commit on main so we can branch off it
    await writeFile(join(cloneDir, "README.md"), "init\n");
    git(["add", "."], cloneDir);
    git(["commit", "-m", "init"], cloneDir);
    git(["push", "origin", "main"], cloneDir);

    // Seed: 1 fresh, 1 stale-no-PR, 1 stale-with-PR
    const longAgo = "2024-01-01T00:00:00Z";
    await commitAndPush(cloneDir, "agent/BEC-100-stale-no-pr", "a.txt", longAgo);
    await commitAndPush(cloneDir, "agent/BEC-101-stale-with-pr", "b.txt", longAgo);
    await commitAndPush(cloneDir, "agent/BEC-102-fresh", "c.txt"); // current date

    git(["checkout", "main"], cloneDir);
  });

  afterEach(async () => {
    await rm(bareRepo, { recursive: true, force: true });
    // cloneDir lives under a parent tempdir; remove its parent
    await rm(join(cloneDir, ".."), { recursive: true, force: true });
  });

  it("deletes only stale branches with no open PR", async () => {
    const result = await sweepStaleAgentBranches({
      workCwd: cloneDir,
      ttlDays: 7,
      hasOpenPR: async (branch) => branch === "agent/BEC-101-stale-with-pr",
    });

    expect(result.deleted.map((d) => d.name)).toEqual([
      "agent/BEC-100-stale-no-pr",
    ]);
    expect(result.deleted[0].ageDays).toBeGreaterThan(7);
    expect(result.skippedHasPR).toEqual(["agent/BEC-101-stale-with-pr"]);
    expect(result.skippedFresh).toEqual(["agent/BEC-102-fresh"]);

    // Verify against the bare remote
    const remoteRefs = git(["ls-remote", "--heads", bareRepo], cloneDir);
    expect(remoteRefs).not.toContain("agent/BEC-100-stale-no-pr");
    expect(remoteRefs).toContain("agent/BEC-101-stale-with-pr");
    expect(remoteRefs).toContain("agent/BEC-102-fresh");
  });

  it("returns empty result when no agent/* branches exist", async () => {
    // Wipe all agent branches first
    for (const b of [
      "agent/BEC-100-stale-no-pr",
      "agent/BEC-101-stale-with-pr",
      "agent/BEC-102-fresh",
    ]) {
      git(["push", "origin", "--delete", b], cloneDir);
    }
    const result = await sweepStaleAgentBranches({
      workCwd: cloneDir,
      ttlDays: 7,
      hasOpenPR: async () => false,
    });
    expect(result).toEqual({ deleted: [], skippedHasPR: [], skippedFresh: [] });
  });

  it("treats hasOpenPR errors as 'has PR' (fail-safe — never deletes a branch we can't verify)", async () => {
    const result = await sweepStaleAgentBranches({
      workCwd: cloneDir,
      ttlDays: 7,
      hasOpenPR: async () => {
        throw new Error("gh API down");
      },
    });
    // All stale branches should be skipped, none deleted
    expect(result.deleted).toEqual([]);
    expect(result.skippedHasPR).toContain("agent/BEC-100-stale-no-pr");
    expect(result.skippedHasPR).toContain("agent/BEC-101-stale-with-pr");
    expect(result.skippedFresh).toEqual(["agent/BEC-102-fresh"]);

    // Defence-in-depth: assert the bare remote was untouched. A future
    // regression that ran the delete BEFORE hasOpenPR would still pass an
    // in-memory assertion alone — verifying remote refs guards that.
    const remoteRefs = git(["ls-remote", "--heads", bareRepo], cloneDir);
    expect(remoteRefs).toContain("agent/BEC-100-stale-no-pr");
    expect(remoteRefs).toContain("agent/BEC-101-stale-with-pr");
    expect(remoteRefs).toContain("agent/BEC-102-fresh");
  });
});

describe("pmAgentBranchSweptEvent", () => {
  it("returns an audit event with the documented shape", () => {
    const event = pmAgentBranchSweptEvent({
      branch: "agent/BEC-100-foo",
      ageDays: 12,
      reason: "stale (no open PR for 7 days)",
    });
    expect(event.eventType).toBe("pm.agent_branch_swept");
    expect(event.actor).toBe("pm-agent");
    expect(event.actorType).toBe("pm-agent");
    expect(event.payload).toEqual({
      branch: "agent/BEC-100-foo",
      ageDays: 12,
      reason: "stale (no open PR for 7 days)",
    });
    expect(event.id).toMatch(/^evt_/);
  });
});
