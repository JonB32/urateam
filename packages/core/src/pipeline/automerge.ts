/**
 * PR automerge eligibility checker and merger.
 *
 * Invoked by the GitHub webhook handler when a PR-related event is received
 * (check_suite.completed, status, pull_request.labeled, etc.).
 *
 * All configured criteria must pass before a merge is attempted.  If branch
 * protection rules would prevent the merge, GitHub's 405 response is caught
 * and surfaced as a non-eligible reason rather than an error.
 */

import type { Octokit } from "@octokit/rest";
import {
  getPRApprovalCount,
  getPRCheckResults,
  mergePRViaApi,
} from "../repo/github.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "automerge" });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutomergeOptions {
  /** Minimum number of unique approving reviews required. Default: 0. */
  minimumApprovingReviews?: number;
  /** Status/check-run context names that must all report "success". Default: []. */
  requiredStatusChecks?: string[];
  /** Labels the PR must carry — all listed labels must be present. Default: []. */
  requiredLabels?: string[];
  /** Base branches the PR is allowed to target. Empty = any branch. Default: []. */
  allowedBranches?: string[];
  /** Merge method. Default: "squash". */
  mergeMethod?: "merge" | "squash" | "rebase";
}

export interface AutomergeCheckResult {
  eligible: boolean;
  reason: string;
}

export interface AutomergeResult {
  merged: boolean;
  /** Human-readable outcome, e.g. "PR auto-merged" or "Branch protection prevented merge". */
  message: string;
}

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

/**
 * Check whether a PR satisfies all configured automerge criteria using the
 * GitHub API.  Returns { eligible: true } only when every criterion passes.
 */
export async function checkAutoMergeEligibility(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  options: AutomergeOptions,
): Promise<AutomergeCheckResult> {
  // Fetch PR details for draft/label/branch checks
  let pr: {
    draft?: boolean | null | undefined;
    base: { ref: string };
    head: { sha: string };
    labels: Array<{ name: string | null }>;
    merged: boolean;
    state: string;
  };

  try {
    const { data } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    pr = data;
  } catch (err: any) {
    return { eligible: false, reason: `Failed to fetch PR details: ${err?.message ?? String(err)}` };
  }

  // Skip draft PRs
  if (pr.draft) {
    return { eligible: false, reason: "PR is a draft" };
  }

  // Skip already-merged PRs
  if (pr.merged || pr.state === "closed") {
    return { eligible: false, reason: "PR is already merged or closed" };
  }

  // Check allowed base branches
  const allowedBranches = options.allowedBranches ?? [];
  if (allowedBranches.length > 0 && !allowedBranches.includes(pr.base.ref)) {
    return {
      eligible: false,
      reason: `Base branch '${pr.base.ref}' is not in allowedBranches: [${allowedBranches.join(", ")}]`,
    };
  }

  // Check required labels
  const requiredLabels = options.requiredLabels ?? [];
  if (requiredLabels.length > 0) {
    const prLabelNames = pr.labels.map((l) => l.name ?? "").filter(Boolean);
    const missingLabels = requiredLabels.filter((l) => !prLabelNames.includes(l));
    if (missingLabels.length > 0) {
      return {
        eligible: false,
        reason: `PR is missing required labels: ${missingLabels.join(", ")}`,
      };
    }
  }

  // Check minimum approving reviews
  const minApprovals = options.minimumApprovingReviews ?? 0;
  if (minApprovals > 0) {
    let approvalCount: number;
    try {
      approvalCount = await getPRApprovalCount(octokit, owner, repo, prNumber);
    } catch (err: any) {
      return { eligible: false, reason: `Failed to fetch reviews: ${err?.message ?? String(err)}` };
    }
    if (approvalCount < minApprovals) {
      return {
        eligible: false,
        reason: `PR has ${approvalCount} approving review(s), need ${minApprovals}`,
      };
    }
  }

  // Check required status checks
  const requiredChecks = options.requiredStatusChecks ?? [];
  if (requiredChecks.length > 0) {
    let checkResults: Map<string, string>;
    try {
      checkResults = await getPRCheckResults(octokit, owner, repo, pr.head.sha);
    } catch (err: any) {
      return { eligible: false, reason: `Failed to fetch status checks: ${err?.message ?? String(err)}` };
    }

    for (const checkName of requiredChecks) {
      const conclusion = checkResults.get(checkName);
      // "success" and "neutral" are both acceptable passing states
      if (!conclusion || (conclusion !== "success" && conclusion !== "neutral")) {
        return {
          eligible: false,
          reason: `Required status check '${checkName}' has not passed (status: ${conclusion ?? "not found"})`,
        };
      }
    }
  }

  return { eligible: true, reason: "All automerge criteria met" };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Attempt to merge a PR after verifying eligibility.  Returns a result
 * object describing the outcome.  Does NOT throw — all errors are surfaced
 * as non-merged results so callers can log/notify without crashing.
 */
export async function attemptAutoMerge(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  options: AutomergeOptions,
): Promise<AutomergeResult> {
  log.info({ owner, repo, prNumber }, "checking PR for automerge eligibility");

  const eligibility = await checkAutoMergeEligibility(octokit, owner, repo, prNumber, options);
  if (!eligibility.eligible) {
    log.info({ owner, repo, prNumber, reason: eligibility.reason }, "PR not eligible for automerge");
    return { merged: false, message: eligibility.reason };
  }

  const mergeMethod = options.mergeMethod ?? "squash";
  log.info({ owner, repo, prNumber, mergeMethod }, "PR eligible — attempting automerge");

  try {
    const result = await mergePRViaApi(octokit, owner, repo, prNumber, mergeMethod);
    if (result.merged) {
      log.info({ owner, repo, prNumber }, "PR auto-merged successfully");
      return { merged: true, message: "PR auto-merged successfully" };
    }
    log.warn({ owner, repo, prNumber, message: result.message }, "automerge API call failed");
    return { merged: false, message: result.message };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    log.error({ err, owner, repo, prNumber }, "automerge threw an unexpected error");
    return { merged: false, message: `Automerge error: ${message}` };
  }
}
