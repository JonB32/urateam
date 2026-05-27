import { and, eq, isNull, desc, gte, or, isNotNull, type SQL } from "drizzle-orm";
import type { Octokit } from "@octokit/rest";
import type { AnyDb } from "../db/client.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { parseRepoFromUrl } from "./github.js";
import type { CollectedState } from "./types.js";

const log = createLogger({ component: "ReleaseManager:state" });

/** Matches both plain (v1.2.3) and prerelease (v1.2.3-beta.1) semver tags. */
export const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/;

const CI_STATUS = {
  GREEN: "green" as const,
  NOT_GREEN: "not-green" as const,
  UNAVAILABLE: "unavailable" as const,
} as const;

/**
 * Shared helper: fetch the latest single row from `releaseDecisions` filtered by
 * repo/branch plus an additional predicate, ordered by `decidedAt DESC`.
 * Both the `lastFired` and `latestQaRun` queries share this structure.
 */
async function queryLatestReleaseDecision(
  db: AnyDb,
  repoUrl: string,
  branch: string,
  additionalCondition: SQL<unknown> | undefined,
  selectFields: Record<string, unknown>,
): Promise<unknown[]> {
  return (db as any)
    .select(selectFields)
    .from(releaseDecisions)
    .where(and(eq(releaseDecisions.repoUrl, repoUrl), eq(releaseDecisions.branch, branch), additionalCondition))
    .orderBy(desc(releaseDecisions.decidedAt))
    .limit(1);
}

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

  // 1 & 2. HEAD SHA and latest tags — independent API calls, run in parallel.
  const [branchRes, tagsResOrNull] = await Promise.all([
    octokit.repos.getBranch({ owner, repo, branch }),
    octokit.repos.listTags({ owner, repo, per_page: 30 }).catch((err: unknown) => {
      log.warn({ err, repoUrl, branch }, "listTags failed — treating as no-tag");
      return null;
    }),
  ]);
  const headSha: string = (branchRes as any).data.commit.sha;

  // Latest tag (matching v*.*.* convention).
  let lastTag: string | null = null;
  let lastTagSha: string | null = null;
  let lastTagAt: Date | null = null;
  try {
    const tagsData = tagsResOrNull ? ((tagsResOrNull as any).data ?? []) : [];
    const candidate = tagsData.find((t: any) => RELEASE_TAG_RE.test(t.name));
    if (candidate) {
      lastTag = candidate.name.startsWith("v") ? candidate.name : `v${candidate.name}`;
      lastTagSha = candidate.commit.sha;
      // Tag commit timestamp — use the commit's committer date for a wall-clock anchor.
      const commit = await octokit.repos.getCommit({ owner, repo, ref: lastTagSha! });
      const commitData = (commit as any).data?.commit;
      const dateStr = commitData?.committer?.date ?? commitData?.author?.date;
      lastTagAt = dateStr ? new Date(dateStr) : null;
    }
  } catch (err) {
    log.warn({ err, repoUrl, branch }, "tag/commit fetch failed — treating as no-tag");
  }

  // 3. Manual-tag detection: did any release_decisions with kind="fire" or
  //    "fire-pending" record a fired_tag, and does the current latest tag
  //    differ from it? Including "fire-pending" prevents a partial-fire tag
  //    from being misread as a human-created manual tag on the next tick.
  const lastFired = await queryLatestReleaseDecision(
    db,
    repoUrl,
    branch,
    or(
      eq(releaseDecisions.decision, "fire"),
      eq(releaseDecisions.decision, "fire-pending"),
    ),
    { firedTag: releaseDecisions.firedTag },
  ) as Array<{ firedTag: string | null }>;
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
  let ciStatus: "green" | "not-green" | "unavailable" = CI_STATUS.UNAVAILABLE;
  let ciGreenSince: Date | null = null;
  try {
    const checks = await octokit.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 });
    const runs = ((checks as any).data?.check_runs ?? []) as Array<{
      status: string;
      conclusion: string | null;
      completed_at: string | null;
    }>;
    if (runs.length === 0) {
      ciStatus = CI_STATUS.UNAVAILABLE;
    } else {
      const allCompleted = runs.every((r) => r.status === "completed");
      const allSuccess = runs.every((r) => r.conclusion === "success");
      if (!allCompleted) {
        ciStatus = CI_STATUS.NOT_GREEN;
      } else if (allSuccess) {
        ciStatus = CI_STATUS.GREEN;
        // ciGreenSince = latest completed_at across all runs
        const completedAts = runs
          .map((r) => (r.completed_at ? new Date(r.completed_at).getTime() : null))
          .filter((t): t is number => t !== null);
        if (completedAts.length > 0) {
          ciGreenSince = new Date(Math.max(...completedAts));
        }
      } else {
        ciStatus = CI_STATUS.NOT_GREEN;
      }
    }
  } catch (err) {
    log.warn({ err }, "checks.listForRef failed — ciStatus unavailable");
    ciStatus = CI_STATUS.UNAVAILABLE;
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
  // Uses the partial index idx_release_decisions_qa_run_id (WHERE qa_run_id IS NOT NULL)
  // created in migrations 010_qa_run_columns.sql (SQLite) / 011_qa_run_columns.sql (Postgres).
  const latestQaRows = await queryLatestReleaseDecision(
    db,
    repoUrl,
    branch,
    isNotNull(releaseDecisions.qaRunId),
    {
      qaRunId: releaseDecisions.qaRunId,
      qaRunSha: releaseDecisions.qaRunSha,
      decidedAt: releaseDecisions.decidedAt,
    },
  ) as Array<{ qaRunId: number | null; qaRunSha: string | null; decidedAt: Date | number }>;
  const latestQaRow = latestQaRows[0] ?? null;
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
