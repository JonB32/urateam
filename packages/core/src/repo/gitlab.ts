/**
 * GitLab repo provider.
 *
 * Supports:
 *  - Clone via GitLab deploy tokens (embed credentials in the remote URL).
 *  - Merge request creation via the GitLab REST API.
 *  - Self-hosted GitLab instances via the optional `host` field.
 */

export interface GitLabConfig {
  /** Personal access token, project access token, or deploy token with api scope. */
  token: string;
  /**
   * GitLab host (no trailing slash). Defaults to "https://gitlab.com".
   * Override for self-hosted instances, e.g. "https://gitlab.example.com".
   */
  host?: string;
}

export interface CreateMROptions {
  /** GitLab namespace+project path, e.g. "myorg/myrepo". */
  projectPath: string;
  /** Source branch to merge from. */
  sourceBranch: string;
  /** Target branch to merge into. */
  targetBranch: string;
  title: string;
  description: string;
  /** GitHub usernames — ignored on GitLab (warn-only). */
  reviewers?: string[];
  /** GitHub team slugs — ignored on GitLab (warn-only). */
  teamReviewers?: string[];
}

/**
 * Inject deploy-token credentials into a GitLab HTTPS clone URL so that
 * `git clone` / `git push` works without interactive prompts.
 *
 * Input:  https://gitlab.com/myorg/myrepo.git
 * Output: https://<tokenUser>:<token>@gitlab.com/myorg/myrepo.git
 *
 * If the URL already contains credentials this is a no-op.
 */
export function buildAuthenticatedUrl(
  repoUrl: string,
  config: GitLabConfig,
  tokenUser = "oauth2",
): string {
  const parsed = new URL(repoUrl);
  if (parsed.username) {
    // Already has credentials — don't overwrite.
    return repoUrl;
  }
  parsed.username = tokenUser;
  parsed.password = config.token;
  return parsed.toString();
}

/**
 * Create a merge request via the GitLab REST API.
 * Returns the MR web URL on success.
 */
export async function createMR(
  config: GitLabConfig,
  options: CreateMROptions,
): Promise<string> {
  if (
    (options.reviewers && options.reviewers.length > 0) ||
    (options.teamReviewers && options.teamReviewers.length > 0)
  ) {
    // Mandatory reviewers (enterprise feature 4.6) are not wired through to
    // GitLab's assignee/reviewer API in v1 — log informatively and ignore.
    const { createLogger } = await import("../logger.js");
    createLogger({ module: "repo/gitlab" }).info(
      { reviewers: options.reviewers, teamReviewers: options.teamReviewers },
      "GitLab path does not request reviewers via API; configured reviewers are not applied",
    );
  }

  const host = config.host ?? "https://gitlab.com";
  const encodedPath = encodeURIComponent(options.projectPath);
  const apiUrl = `${host}/api/v4/projects/${encodedPath}/merge_requests`;

  const body = JSON.stringify({
    source_branch: options.sourceBranch,
    target_branch: options.targetBranch,
    title: options.title,
    description: options.description,
    remove_source_branch: true,
  });

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PRIVATE-TOKEN": config.token,
    },
    body,
  });

  if (response.status === 409) {
    // MR already exists for this source→target — fetch the existing one
    const listUrl = `${host}/api/v4/projects/${encodedPath}/merge_requests?source_branch=${encodeURIComponent(options.sourceBranch)}&target_branch=${encodeURIComponent(options.targetBranch)}&state=opened`;
    const listResp = await fetch(listUrl, {
      headers: { "PRIVATE-TOKEN": config.token },
    });
    if (listResp.ok) {
      const mrs = (await listResp.json()) as Array<{ web_url: string }>;
      if (mrs.length > 0) return mrs[0].web_url;
    }
    // Couldn't find existing MR — fall through to error
  }

  if (!response.ok) {
    await response.text().catch(() => {}); // drain body
    throw new Error(
      `GitLab API error ${response.status} creating MR`,
    );
  }

  const data = (await response.json()) as { web_url: string };
  return data.web_url;
}

/**
 * Trigger merge when all CI pipelines succeed (`merge_when_pipeline_succeeds`).
 *
 * Equivalent to clicking "Merge when pipeline succeeds" in the GitLab UI.
 * Returns true when the API accepted the request, false on failure.
 *
 * @param config - GitLab authentication config (token + optional host).
 * @param projectPath - GitLab namespace+project path, e.g. "myorg/myrepo".
 * @param mrIid - The merge request IID (internal ID shown in the URL, e.g. 42).
 */
export async function mergeMRWhenPipelineSucceeds(
  config: GitLabConfig,
  projectPath: string,
  mrIid: number,
): Promise<boolean> {
  const host = config.host ?? "https://gitlab.com";
  const encodedPath = encodeURIComponent(projectPath);
  const apiUrl = `${host}/api/v4/projects/${encodedPath}/merge_requests/${mrIid}/merge`;

  try {
    const response = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "PRIVATE-TOKEN": config.token,
      },
      body: JSON.stringify({ merge_when_pipeline_succeeds: true }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<no body>");
      const { createLogger } = await import("../logger.js");
      createLogger({ module: "repo/gitlab" }).error(
        { status: response.status, body: text, mrIid },
        "GitLab merge_when_pipeline_succeeds API error",
      );
      return false;
    }
    return true;
  } catch (err) {
    const { createLogger } = await import("../logger.js");
    createLogger({ module: "repo/gitlab" }).error(
      { err, mrIid },
      "GitLab mergeMRWhenPipelineSucceeds request failed",
    );
    return false;
  }
}

/**
 * Add a comment (note) to an existing merge request.
 */
export async function addMRComment(
  config: GitLabConfig,
  projectPath: string,
  mrIid: number,
  body: string,
): Promise<void> {
  const host = config.host ?? "https://gitlab.com";
  const encodedPath = encodeURIComponent(projectPath);
  const apiUrl = `${host}/api/v4/projects/${encodedPath}/merge_requests/${mrIid}/notes`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PRIVATE-TOKEN": config.token,
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(
      `GitLab API error ${response.status} adding MR comment: ${text}`,
    );
  }
}
