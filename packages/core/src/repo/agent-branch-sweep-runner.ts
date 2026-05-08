import { execFile } from "node:child_process";
import { join } from "node:path";
import type { AnyDb } from "../db/client.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { pmAgentBranchSweptEvent } from "../audit/events.js";
import { createLogger } from "../logger.js";
import { cloneRepo } from "./git.js";
import { sweepStaleAgentBranches } from "./agent-branch-sweep.js";

const log = createLogger({ component: "agent-branch-sweep-runner" });

/**
 * Default open-PR check via `gh pr list`. Errors propagate to the caller, which
 * treats them as "has PR" (fail-safe — never delete a branch we couldn't verify).
 */
async function defaultHasOpenPR(repoUrl: string, branch: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [
        "pr", "list",
        "--repo", repoUrl,
        "--head", branch,
        "--state", "open",
        "--json", "number",
        "--limit", "1",
      ],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const arr = JSON.parse(stdout || "[]");
          resolve(Array.isArray(arr) && arr.length > 0);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

export interface RunAgentBranchSweepDeps {
  db: AnyDb;
  /** Distinct repo URLs to sweep. Duplicates are silently skipped. */
  repoUrls: string[];
  /** Used as the parent directory for the transient sweep clone. */
  repoCloneDir: string;
  /** Branches older than this with no open PR are deleted. */
  ttlDays: number;
  /** Test seam — defaults to a `gh pr list` shell-out. */
  hasOpenPR?: (repoUrl: string, branch: string) => Promise<boolean>;
}

/**
 * BEC-174: sweep stale `agent/*` branches across every configured repo.
 * Emits one `pm.agent_branch_swept` audit event per deleted branch.
 *
 * Tolerates per-repo failures: a clone error or sweep error in one repo
 * does not stop processing of subsequent repos.
 */
export async function runAgentBranchSweep(
  deps: RunAgentBranchSweepDeps,
): Promise<void> {
  const seen = new Set<string>();
  const sweepDir = join(deps.repoCloneDir, ".agent-sweep");
  for (const repoUrl of deps.repoUrls) {
    if (seen.has(repoUrl)) continue;
    seen.add(repoUrl);
    try {
      await cloneRepo(repoUrl, sweepDir);
      const result = await sweepStaleAgentBranches({
        workCwd: sweepDir,
        ttlDays: deps.ttlDays,
        hasOpenPR: (branch) =>
          (deps.hasOpenPR ?? defaultHasOpenPR)(repoUrl, branch),
      });

      for (const swept of result.deleted) {
        void logAuditEventUnchecked(
          deps.db,
          pmAgentBranchSweptEvent({
            branch: swept.name,
            ageDays: swept.ageDays,
            reason: `stale (no open PR for ${deps.ttlDays}+ days)`,
          }),
        );
      }
      if (result.deleted.length > 0) {
        log.info(
          { repoUrl, count: result.deleted.length },
          `branch sweep removed ${result.deleted.length} stale agent branch(es)`,
        );
      }
    } catch (err) {
      log.warn(
        { repoUrl, err: (err as Error).message },
        "branch sweep failed for repo",
      );
    }
  }
}
