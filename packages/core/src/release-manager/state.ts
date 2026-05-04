import { and, eq, isNull, desc, gte } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { parseRepoFromUrl } from "./github.js";
import type { CollectedState } from "./types.js";

const log = createLogger({ component: "ReleaseManager:state" });

export interface CollectStateInput {
  octokit: Octokit;
  db: AnyDb;
  repoUrl: string;
  branch: string;
  /** Approval freshness window in ms (computed from triggers.timeSinceLastHours, default 24h). */
  approvalTtlMs: number;
}

/**
 * Single GitHub call surface for one tick. Wrapped in try/catch by the
 * scheduler — failures here surface as "ci_check_unavailable" or are
 * re-thrown depending on which API failed.
 */
export async function collectState(input: CollectStateInput): Promise<CollectedState> {
  const { octokit, db, repoUrl, branch, approvalTtlMs } = input;
  const { owner, repo } = parseRepoFromUrl(repoUrl);

  // 1. HEAD SHA of the configured branch
  const branchRes = await octokit.repos.getBranch({ owner, repo, branch });
  const headSha: string = (branchRes as any).data.commit.sha;

  // 2. Latest tag (matching v*.*.* convention).
  let lastTag: string | null = null;
  let lastTagSha: string | null = null;
  let lastTagAt: Date | null = null;
  try {
    const tagsRes = await octokit.repos.listTags({ owner, repo, per_page: 30 });
    const candidate = (tagsRes as any).data.find((t: any) => /^v?\d+\.\d+\.\d+$/.test(t.name));
    if (candidate) {
      lastTag = candidate.name.startsWith("v") ? candidate.name : `v${candidate.name}`;
      lastTagSha = candidate.commit.sha;
      // Tag commit timestamp — use the commit's committer date for a wall-clock anchor.
      const commit = await octokit.repos.getCommit({ owner, repo, ref: lastTagSha! });
      const dateStr = (commit as any).data?.commit?.committer?.date ?? (commit as any).data?.commit?.author?.date;
      lastTagAt = dateStr ? new Date(dateStr) : null;
    }
  } catch (err) {
    log.warn({ err, repoUrl, branch }, "listTags failed — treating as no-tag");
  }

  // 3. Manual-tag detection: did any release_decisions with kind="fire" record
  //    a fired_tag, and does the current latest tag differ from it?
  const lastFired = await (db as any)
    .select({ firedTag: releaseDecisions.firedTag })
    .from(releaseDecisions)
    .where(
      and(
        eq(releaseDecisions.repoUrl, repoUrl),
        eq(releaseDecisions.branch, branch),
        eq(releaseDecisions.decision, "fire"),
      ),
    )
    .orderBy(desc(releaseDecisions.decidedAt))
    .limit(1);
  const lastFiredTag: string | null = lastFired?.[0]?.firedTag ?? null;
  const manualTagDetected = lastTag !== null && lastFiredTag !== null && lastTag !== lastFiredTag;

  // 4. Commits between lastTagSha and headSha (proxy for "merged PRs since last tag").
  let mergedCommitsSinceLastTag = 0;
  let commitsSinceLastTag: Array<{ message: string }> = [];
  if (lastTagSha) {
    try {
      const cmp = await octokit.repos.compareCommits({ owner, repo, base: lastTagSha, head: headSha });
      const commits = (cmp as any).data.commits ?? [];
      mergedCommitsSinceLastTag = commits.length;
      commitsSinceLastTag = commits.map((c: any) => ({ message: c?.commit?.message ?? "" }));
    } catch (err) {
      log.warn({ err, lastTagSha, headSha }, "compareCommits failed");
    }
  } else {
    // No prior tag — count all commits on branch (cap at first page; v2 paginates).
    try {
      const list = await octokit.repos.listCommits({ owner, repo, sha: branch, per_page: 100 });
      mergedCommitsSinceLastTag = ((list as any).data ?? []).length;
      commitsSinceLastTag = ((list as any).data ?? []).map((c: any) => ({
        message: c?.commit?.message ?? "",
      }));
    } catch (err) {
      log.warn({ err }, "listCommits failed");
    }
  }

  // 5. CI status for headSha — aggregate check_runs.
  let ciStatus: "green" | "not-green" | "unavailable" = "unavailable";
  let ciGreenSince: Date | null = null;
  try {
    const checks = await octokit.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 });
    const runs = ((checks as any).data?.check_runs ?? []) as Array<{
      status: string;
      conclusion: string | null;
      completed_at: string | null;
    }>;
    if (runs.length === 0) {
      ciStatus = "unavailable";
    } else {
      const allCompleted = runs.every((r) => r.status === "completed");
      const allSuccess = runs.every((r) => r.conclusion === "success");
      if (!allCompleted) {
        ciStatus = "not-green";
      } else if (allSuccess) {
        ciStatus = "green";
        // ciGreenSince = latest completed_at across all runs
        const completedAts = runs
          .map((r) => (r.completed_at ? new Date(r.completed_at).getTime() : null))
          .filter((t): t is number => t !== null);
        if (completedAts.length > 0) {
          ciGreenSince = new Date(Math.max(...completedAts));
        }
      } else {
        ciStatus = "not-green";
      }
    }
  } catch (err) {
    log.warn({ err }, "checks.listForRef failed — ciStatus unavailable");
    ciStatus = "unavailable";
  }

  // 6. Fresh approval lookup. "Fresh" = consumed_at IS NULL AND approved_at within approvalTtlMs.
  // Use drizzle's gte() so the cross-dialect crossTimestamp serializer converts
  // Date → INTEGER epoch on SQLite and Date → TIMESTAMPTZ on Postgres correctly.
  const cutoff = new Date(Date.now() - approvalTtlMs);
  const freshRows = await (db as any)
    .select({ approvedBy: releaseApprovals.approvedBy, approvedAt: releaseApprovals.approvedAt })
    .from(releaseApprovals)
    .where(
      and(
        eq(releaseApprovals.repoUrl, repoUrl),
        eq(releaseApprovals.branch, branch),
        isNull(releaseApprovals.consumedAt),
        gte(releaseApprovals.approvedAt, cutoff),
      ),
    )
    .orderBy(desc(releaseApprovals.approvedAt))
    .limit(1);
  const hasFreshApproval = (freshRows?.length ?? 0) > 0;
  const freshApprovalApprover = hasFreshApproval ? freshRows[0].approvedBy : null;

  // 7. BEC-136: most-recent in-flight QA run snapshot.
  const qaRunRows = await (db as any)
    .select({
      qaRunId: releaseDecisions.qaRunId,
      qaRunSha: releaseDecisions.qaRunSha,
      decidedAt: releaseDecisions.decidedAt,
    })
    .from(releaseDecisions)
    .where(
      and(
        eq(releaseDecisions.repoUrl, repoUrl),
        eq(releaseDecisions.branch, branch),
      ),
    )
    .orderBy(desc(releaseDecisions.decidedAt))
    .limit(20);
  // Take the most recent row that actually has a qa_run_id.
  const latestQaRow = qaRunRows.find((r: any) => r.qaRunId !== null && r.qaRunId !== undefined);
  const qaRun = latestQaRow
    ? {
        runId: latestQaRow.qaRunId as number,
        runSha: latestQaRow.qaRunSha as string,
        triggeredAt: latestQaRow.decidedAt instanceof Date ? latestQaRow.decidedAt : new Date(latestQaRow.decidedAt),
      }
    : null;

  return {
    lastTag,
    lastTagSha,
    lastTagAt,
    headSha,
    mergedCommitsSinceLastTag,
    commitsSinceLastTag,
    ciStatus,
    ciGreenSince,
    hasFreshApproval,
    freshApprovalApprover,
    manualTagDetected,
    qaRun,
  };
}
