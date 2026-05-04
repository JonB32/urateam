import type { Octokit } from "@octokit/rest";

export interface CreateTagAndReleaseInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  tag: string;   // e.g. "v1.2.4"
  sha: string;   // commit SHA to tag
}

export type CreateTagAndReleaseResult =
  | { kind: "ok"; releaseUrl: string }
  | { kind: "tag_exists" }
  | { kind: "release_create_failed"; message: string }
  | { kind: "other_error"; message: string };

/**
 * Parse owner/repo from a GitHub URL. Accepts both https and ssh forms.
 *
 * Examples:
 *   https://github.com/org/repo        → { owner: "org", repo: "repo" }
 *   https://github.com/org/repo.git    → { owner: "org", repo: "repo" }
 *   git@github.com:org/repo.git        → { owner: "org", repo: "repo" }
 */
export function parseRepoFromUrl(url: string): { owner: string; repo: string } {
  // ssh
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // https
  const https = url.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  throw new Error(`unparseable GitHub URL: ${url}`);
}

/**
 * Create a git tag and a release with auto-generated notes.
 *
 * Two-step:
 *   1. octokit.git.createRef('refs/tags/<tag>', sha)
 *   2. octokit.repos.createRelease({ tag_name, target_commitish: sha, generate_release_notes: true })
 *
 * Errors are classified — the caller persists a different decision row for
 * each kind:
 *   - tag_exists           → skip with reason="tag_exists"
 *   - release_create_failed → fire-pending with attempt_count++ (retryable)
 *   - other_error          → tick error (logged, not a decision row)
 */
export async function createTagAndRelease(
  input: CreateTagAndReleaseInput,
): Promise<CreateTagAndReleaseResult> {
  const { octokit, owner, repo, tag, sha } = input;

  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const status = err?.status;
    if (status === 422 || /already exists/i.test(msg)) {
      return { kind: "tag_exists" };
    }
    return { kind: "other_error", message: msg };
  }

  try {
    const res = await octokit.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      target_commitish: sha,
      generate_release_notes: true,
    });
    const releaseUrl =
      (res as any)?.data?.html_url ?? `https://github.com/${owner}/${repo}/releases/tag/${tag}`;
    return { kind: "ok", releaseUrl };
  } catch (err: any) {
    return { kind: "release_create_failed", message: err?.message ?? String(err) };
  }
}
