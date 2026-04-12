import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

export interface GitHubConfig {
  appId: string;
  privateKey: string;
  installationId?: number;
}

export interface CreatePROptions {
  owner: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

/**
 * Create an authenticated Octokit instance using GitHub App credentials.
 */
export async function createGitHubClient(
  config: GitHubConfig,
): Promise<Octokit> {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  });
  return octokit;
}

/**
 * Create a pull request and return the PR URL (html_url).
 */
export async function createPR(
  octokit: Octokit,
  options: CreatePROptions,
): Promise<string> {
  const response = await octokit.pulls.create({
    owner: options.owner,
    repo: options.repo,
    head: options.branch,
    base: options.base,
    title: options.title,
    body: options.body,
    draft: options.draft ?? false,
  });
  return response.data.html_url;
}

/**
 * Add a comment to a pull request.
 */
export async function addPRComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

/**
 * Count the number of unique approving reviews on a PR.
 * Uses the latest state per reviewer — a reviewer who approved then requested changes
 * is not counted as approving.
 */
export async function getPRApprovalCount(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const { data: reviews } = await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  // Keep only the latest review state per reviewer user id
  const latestByReviewer = new Map<number, string>();
  for (const review of reviews) {
    const userId = review.user?.id ?? 0;
    latestByReviewer.set(userId, review.state);
  }
  return [...latestByReviewer.values()].filter((state) => state === "APPROVED").length;
}

/**
 * Get all passing/failing check names for a commit SHA.
 * Covers both legacy commit statuses and modern GitHub check runs.
 * Returns a map from check name → conclusion ("success" | "failure" | "pending" | …).
 */
export async function getPRCheckResults(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Legacy commit statuses
  try {
    const { data: combined } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: sha,
    });
    for (const status of combined.statuses) {
      results.set(status.context, status.state); // "success" | "failure" | "pending" | "error"
    }
  } catch {
    // Ignore — repo may not use legacy statuses
  }

  // Modern check runs
  try {
    const { data: checkData } = await (octokit as any).checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    for (const run of checkData.check_runs as Array<{ name: string; conclusion: string | null }>) {
      results.set(run.name, run.conclusion ?? "pending");
    }
  } catch {
    // Ignore — repo may not use checks API
  }

  return results;
}

/**
 * Merge a pull request via the GitHub API.
 * Returns { merged: true } on success.
 * Returns { merged: false, message } if branch protection prevents the merge or there is a conflict.
 * Throws on unexpected errors.
 */
export async function mergePRViaApi(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
): Promise<{ merged: boolean; message: string }> {
  try {
    const response = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: mergeMethod,
    });
    return {
      merged: response.data.merged,
      message: (response.data as any).message ?? "Merged successfully",
    };
  } catch (err: any) {
    const status = err?.status ?? 0;
    const message: string = err?.message ?? String(err);
    if (status === 405) {
      // Branch protection rules prevented the merge
      return { merged: false, message: `Branch protection prevented merge: ${message}` };
    }
    if (status === 409) {
      // Merge conflict
      return { merged: false, message: `Merge conflict: ${message}` };
    }
    if (status === 422) {
      // Validation failed (e.g. PR already merged)
      return { merged: false, message: `Merge validation failed: ${message}` };
    }
    throw err;
  }
}

/**
 * Re-request review from the current reviewers on a pull request.
 * Fetches the list of requested reviewers from the PR and re-requests them.
 * Returns true if review was re-requested, false if there were no reviewers to re-request.
 */
export async function rerequestPRReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  // Get current requested reviewers
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const reviewers = pr.requested_reviewers?.map((r: { login: string }) => r.login) ?? [];
  const teamReviewers = pr.requested_teams?.map((t: { slug: string }) => t.slug) ?? [];

  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return false;
  }

  await octokit.pulls.requestReviewers({
    owner,
    repo,
    pull_number: prNumber,
    reviewers,
    team_reviewers: teamReviewers,
  });
  return true;
}
