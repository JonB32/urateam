import { execFile } from "node:child_process";
import type { AnyDb } from "../db/client.js";
import type { RepoConfig } from "../types.js";
import { pipelineRuns } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "branch-classifier" });

export type BranchState = "open-pr" | "stale" | "active-run";

export interface BranchClassification {
  state: BranchState;
  /** PR number if an open PR exists for this branch (state === "open-pr"). */
  prNumber?: number;
  /** PR URL if an open PR exists for this branch (state === "open-pr"). */
  prUrl?: string;
  /** Active pipeline run ID if a run currently holds this branch (state === "active-run"). */
  runId?: string;
}

export interface ClassifierDeps {
  /**
   * Injectable PR checker — defaults to querying the GitHub CLI.
   * Override in tests to avoid network calls.
   */
  checkOpenPR?: (
    repoUrl: string,
    branch: string,
  ) => Promise<{ prNumber: number; prUrl: string } | null>;
}

/**
 * Classify the state of an existing remote branch so the pipeline runner can
 * decide the right recovery action.
 *
 * | State       | Meaning                                                   |
 * |-------------|-----------------------------------------------------------|
 * | active-run  | A DB pipeline run with status "running"/"queued" holds   |
 * |             | this branch right now.  Preserve current skip behaviour. |
 * | open-pr     | No active run, but an open PR exists for the branch.     |
 * |             | Issue is in review — don't restart from scratch.         |
 * | stale       | No active run, no open PR. Dead branch from a prior      |
 * |             | failed/cancelled run. Safe to delete and retry.          |
 *
 * Pure read operation — no DB writes, no branch mutations.
 */
export async function classifyExistingBranch(
  repoConfig: RepoConfig,
  branch: string,
  db: AnyDb,
  deps?: ClassifierDeps,
): Promise<BranchClassification> {
  // 1. Check DB for active runs that currently hold this branch.
  const activeRows = await (db as any)
    .select({ id: pipelineRuns.id })
    .from(pipelineRuns)
    .where(sql`${pipelineRuns.branch} = ${branch} AND ${pipelineRuns.status} IN ('running', 'queued')`)
    .limit(1);

  if (activeRows.length > 0) {
    return { state: "active-run", runId: activeRows[0].id as string };
  }

  // 2. Check for an open PR on the remote (GitHub only; other providers fall
  //    through to "stale" which is the safe conservative choice).
  const checkPR = deps?.checkOpenPR ?? defaultCheckOpenPR;
  try {
    const prInfo = await checkPR(repoConfig.url, branch);
    if (prInfo) {
      return { state: "open-pr", prNumber: prInfo.prNumber, prUrl: prInfo.prUrl };
    }
  } catch (err) {
    log.warn({ err, branch }, "PR check failed — treating as stale");
  }

  return { state: "stale" };
}

/**
 * Default implementation: uses the `gh` CLI to list open PRs for the given
 * branch.  Fail-open: returns null when `gh` is unavailable or the repo is
 * not GitHub (non-github.com URL), so the caller falls through to "stale".
 */
async function defaultCheckOpenPR(
  repoUrl: string,
  branch: string,
): Promise<{ prNumber: number; prUrl: string } | null> {
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null; // Non-GitHub repo — skip PR check

  const repo = `${match[1]}/${match[2]}`;
  return new Promise((resolve) => {
    execFile(
      "gh",
      [
        "pr", "list",
        "--repo", repo,
        "--head", branch,
        "--state", "open",
        "--json", "number,url",
        "--limit", "1",
      ],
      { timeout: 15_000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const prs = JSON.parse(stdout.trim());
          if (Array.isArray(prs) && prs.length > 0) {
            resolve({ prNumber: prs[0].number as number, prUrl: prs[0].url as string });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      },
    );
  });
}
