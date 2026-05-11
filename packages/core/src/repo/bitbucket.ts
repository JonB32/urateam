/**
 * Bitbucket Cloud repo provider.
 *
 * Supports:
 *  - Clone via OAuth access token (embed credentials in the remote URL).
 *  - Pull request creation via the Bitbucket REST API v2.
 *  - PR comment posting and merging.
 *
 * ## Environment / Authentication
 *
 * Bitbucket Cloud supports two auth methods:
 *  1. **OAuth access token** — set `accessToken` in `BitbucketConfig`.
 *     Clone URL becomes `https://x-token-auth:<token>@bitbucket.org/workspace/repo.git`.
 *  2. **App Password** — set `appUsername` + `appPassword` in `BitbucketConfig`.
 *     Clone URL becomes `https://<username>:<app_password>@bitbucket.org/workspace/repo.git`.
 *
 * At least one of the two auth methods must be provided for API calls.
 * The `workspace` and `repoSlug` fields identify the repository.
 *
 * ## API Reference
 * All API calls target `https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}`.
 * See https://developer.atlassian.com/bitbucket/api/2/reference/resource/repositories/%7Bworkspace%7D/%7Brepo_slug%7D/pullrequests
 */

export interface BitbucketConfig {
  /**
   * OAuth 2.0 access token. When provided, used as Bearer token for API calls
   * and embedded as `x-token-auth:<token>` user in clone URLs.
   * Mutually exclusive with appUsername+appPassword (accessToken takes priority).
   */
  accessToken?: string;
  /**
   * Bitbucket username for App Password authentication.
   * Required when accessToken is not provided.
   */
  appUsername?: string;
  /**
   * Bitbucket App Password for authentication.
   * Required when accessToken is not provided.
   */
  appPassword?: string;
  /**
   * Bitbucket Cloud API base URL. Defaults to "https://api.bitbucket.org/2.0".
   * Override for Bitbucket Data Center (self-hosted) instances.
   */
  apiBaseUrl?: string;
}

export interface CreateBitbucketPROptions {
  /** Bitbucket workspace slug, e.g. "myworkspace". */
  workspace: string;
  /** Repository slug, e.g. "myrepo". */
  repoSlug: string;
  /** Source branch to merge from. */
  sourceBranch: string;
  /** Target branch to merge into. */
  targetBranch: string;
  title: string;
  description: string;
  /** Whether to create as draft (Bitbucket calls them "draft" PRs since 2022). */
  draft?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build Authorization header value from config.
 * Returns a Bearer token string (OAuth) or Basic auth string (App Password).
 */
function buildAuthHeader(config: BitbucketConfig): string {
  if (config.accessToken) {
    return `Bearer ${config.accessToken}`;
  }
  if (config.appUsername && config.appPassword) {
    const encoded = Buffer.from(
      `${config.appUsername}:${config.appPassword}`,
    ).toString("base64");
    return `Basic ${encoded}`;
  }
  throw new Error(
    "BitbucketConfig requires either accessToken or appUsername+appPassword",
  );
}

function getApiBase(config: BitbucketConfig): string {
  return config.apiBaseUrl ?? "https://api.bitbucket.org/2.0";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject Bitbucket credentials into an HTTPS clone URL so that
 * `git clone` / `git push` works without interactive prompts.
 *
 * Input:  https://bitbucket.org/myworkspace/myrepo.git
 * Output (OAuth):       https://x-token-auth:<token>@bitbucket.org/myworkspace/myrepo.git
 * Output (App Password): https://username:<app_password>@bitbucket.org/myworkspace/myrepo.git
 *
 * If the URL already contains credentials this is a no-op.
 *
 * @requires BITBUCKET_ACCESS_TOKEN or BITBUCKET_APP_USERNAME + BITBUCKET_APP_PASSWORD env vars
 *   (or provide them directly via `config`).
 */
export function buildBitbucketAuthenticatedUrl(
  repoUrl: string,
  config: BitbucketConfig,
): string {
  const parsed = new URL(repoUrl);
  if (parsed.username) {
    // Already has credentials — don't overwrite.
    return repoUrl;
  }
  if (config.accessToken) {
    parsed.username = "x-token-auth";
    parsed.password = config.accessToken;
  } else if (config.appUsername && config.appPassword) {
    parsed.username = config.appUsername;
    parsed.password = config.appPassword;
  } else {
    throw new Error(
      "BitbucketConfig requires either accessToken or appUsername+appPassword",
    );
  }
  return parsed.toString();
}

/**
 * Parse a Bitbucket repo URL into workspace and repoSlug.
 * Handles formats like:
 *   - https://bitbucket.org/workspace/repo
 *   - https://bitbucket.org/workspace/repo.git
 *   - git@bitbucket.org:workspace/repo.git
 */
export function parseBitbucketUrl(
  url: string,
): { workspace: string; repoSlug: string } {
  // SSH format: git@bitbucket.org:workspace/repo.git
  const sshMatch = url.match(/git@bitbucket\.org:([^/]+)\/([^/.]+)/);
  if (sshMatch) {
    return { workspace: sshMatch[1], repoSlug: sshMatch[2] };
  }
  // HTTPS format: https://bitbucket.org/workspace/repo[.git]
  const httpMatch = url.match(/bitbucket\.org\/([^/]+)\/([^/.]+)/);
  if (httpMatch) {
    return { workspace: httpMatch[1], repoSlug: httpMatch[2] };
  }
  throw new Error(`Unable to parse Bitbucket repo URL: ${url}`);
}

/**
 * Create a pull request via the Bitbucket REST API v2.
 *
 * @requires BITBUCKET_ACCESS_TOKEN or (BITBUCKET_APP_USERNAME + BITBUCKET_APP_PASSWORD)
 * Returns the PR web URL on success.
 */
export async function createBitbucketPR(
  config: BitbucketConfig,
  options: CreateBitbucketPROptions,
): Promise<string> {
  const { workspace, repoSlug, sourceBranch, targetBranch, title, description, draft } = options;
  const apiBase = getApiBase(config);
  const apiUrl = `${apiBase}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests`;

  const body: Record<string, unknown> = {
    title,
    description,
    source: { branch: { name: sourceBranch } },
    destination: { branch: { name: targetBranch } },
    close_source_branch: true,
  };
  if (draft) {
    body.draft = true;
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: buildAuthHeader(config),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(
      `Bitbucket API error ${response.status} creating PR: ${text}`,
    );
  }

  const data = (await response.json()) as { links: { html: { href: string } } };
  return data.links.html.href;
}

/**
 * Add a comment to an existing Bitbucket pull request.
 *
 * @requires BITBUCKET_ACCESS_TOKEN or (BITBUCKET_APP_USERNAME + BITBUCKET_APP_PASSWORD)
 */
export async function addBitbucketPRComment(
  config: BitbucketConfig,
  workspace: string,
  repoSlug: string,
  prId: number,
  body: string,
): Promise<void> {
  const apiBase = getApiBase(config);
  const apiUrl = `${apiBase}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/comments`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: buildAuthHeader(config),
    },
    body: JSON.stringify({ content: { raw: body } }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(
      `Bitbucket API error ${response.status} adding PR comment: ${text}`,
    );
  }
}

/**
 * Merge a Bitbucket pull request via the REST API.
 *
 * @requires BITBUCKET_ACCESS_TOKEN or (BITBUCKET_APP_USERNAME + BITBUCKET_APP_PASSWORD)
 * Returns true on success, false when the merge failed.
 */
export async function mergeBitbucketPR(
  config: BitbucketConfig,
  workspace: string,
  repoSlug: string,
  prId: number,
  mergeStrategy: "merge_commit" | "squash" | "fast_forward" = "squash",
): Promise<boolean> {
  const apiBase = getApiBase(config);
  const apiUrl = `${apiBase}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${prId}/merge`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildAuthHeader(config),
      },
      body: JSON.stringify({ merge_strategy: mergeStrategy }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<no body>");
      const { createLogger } = await import("../logger.js");
      createLogger({ module: "repo/bitbucket" }).error(
        { status: response.status, body: text },
        "Bitbucket merge API error",
      );
      return false;
    }
    return true;
  } catch (err) {
    const { createLogger } = await import("../logger.js");
    createLogger({ module: "repo/bitbucket" }).error(
      { err },
      "Bitbucket merge request failed",
    );
    return false;
  }
}
