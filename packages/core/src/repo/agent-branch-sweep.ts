import { gitExec, gitExecSafe } from "./git.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "agent-branch-sweep" });

export interface AgentBranchInfo {
  /** Branch name without the "origin/" remote prefix, e.g. "agent/BEC-100-foo". */
  name: string;
  /** Tip-commit committer date. */
  committedAt: Date;
}

/**
 * Fetch then list every `agent/*` ref on origin, returning the tip commit date
 * for age comparisons. Uses an existing local clone (workCwd) so we can run
 * `git for-each-ref` against the fetched refs.
 */
export async function listRemoteAgentBranches(
  workCwd: string,
): Promise<AgentBranchInfo[]> {
  await gitExec(
    [
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/agent/*:refs/remotes/origin/agent/*",
    ],
    workCwd,
  );
  const out = await gitExecSafe(
    [
      "for-each-ref",
      "--format=%(refname:short) %(committerdate:unix)",
      "refs/remotes/origin/agent/",
    ],
    workCwd,
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx = line.lastIndexOf(" ");
      const refname = line.slice(0, idx);
      const ts = parseInt(line.slice(idx + 1), 10);
      return {
        name: refname.replace(/^origin\//, ""),
        committedAt: new Date(ts * 1000),
      };
    });
}

/** Delete a remote branch via `git push origin --delete`. */
export async function deleteRemoteBranch(
  workCwd: string,
  branch: string,
): Promise<void> {
  await gitExec(["push", "origin", "--delete", branch], workCwd);
}

export interface SweepInput {
  /** A local clone with `origin` set to the repo we're sweeping. */
  workCwd: string;
  /** Branch is "stale" if its tip commit is older than this. */
  ttlDays: number;
  /**
   * Predicate that returns true if a branch has an open PR. Throws are treated
   * as "has PR" (fail-safe — we never delete a branch we couldn't verify).
   */
  hasOpenPR: (branch: string) => Promise<boolean>;
  /** Defaults to `new Date()`. Overridable for tests. */
  now?: Date;
  /** Test seam — defaults to {@link listRemoteAgentBranches}. */
  listBranches?: () => Promise<AgentBranchInfo[]>;
  /** Test seam — defaults to {@link deleteRemoteBranch}. */
  deleteBranch?: (branch: string) => Promise<void>;
}

export interface SweptBranch {
  name: string;
  /** Floor of (now - tipCommitDate) in days. Used for audit reasoning. */
  ageDays: number;
}

export interface SweepResult {
  /** Branches successfully deleted on origin, with their tip-commit age at delete time. */
  deleted: SweptBranch[];
  /** Stale branches that still have an open PR (or whose PR-state lookup failed). */
  skippedHasPR: string[];
  /** Branches younger than the TTL (always preserved). */
  skippedFresh: string[];
}

/**
 * Sweep stale `agent/*` branches on origin. A branch is deleted iff:
 *   1. its tip commit is older than `ttlDays`, AND
 *   2. it has no open PR.
 *
 * Failures from the PR-lookup predicate are treated as "has PR" so a transient
 * GitHub outage can never wipe out an active branch.
 */
export async function sweepStaleAgentBranches(
  input: SweepInput,
): Promise<SweepResult> {
  const list = input.listBranches ?? (() => listRemoteAgentBranches(input.workCwd));
  const del =
    input.deleteBranch ?? ((branch: string) => deleteRemoteBranch(input.workCwd, branch));
  const now = input.now ?? new Date();
  const cutoffMs = now.getTime() - input.ttlDays * 24 * 60 * 60 * 1000;

  const branches = await list();
  const result: SweepResult = { deleted: [], skippedHasPR: [], skippedFresh: [] };

  for (const branch of branches) {
    if (branch.committedAt.getTime() >= cutoffMs) {
      result.skippedFresh.push(branch.name);
      continue;
    }
    let openPr: boolean;
    try {
      openPr = await input.hasOpenPR(branch.name);
    } catch (err) {
      log.warn(
        { branch: branch.name, err: (err as Error).message },
        "hasOpenPR check failed — preserving branch",
      );
      result.skippedHasPR.push(branch.name);
      continue;
    }
    if (openPr) {
      result.skippedHasPR.push(branch.name);
      continue;
    }
    try {
      await del(branch.name);
      const ageDays = Math.floor(
        (now.getTime() - branch.committedAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      result.deleted.push({ name: branch.name, ageDays });
    } catch (err) {
      log.warn(
        { branch: branch.name, err: (err as Error).message },
        "branch delete failed — will retry next sweep",
      );
    }
  }
  return result;
}
