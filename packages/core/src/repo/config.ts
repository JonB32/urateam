import type { RepoConfig } from "../types.js";

/**
 * Resolve a repo config from the repo map.
 * Try projectId first (if provided), then teamId. Return null if not found.
 */
export function resolveRepo(
  teamId: string,
  projectId: string | undefined,
  repoMap: Record<string, RepoConfig>,
): RepoConfig | null {
  if (projectId && repoMap[projectId]) {
    return repoMap[projectId];
  }
  if (repoMap[teamId]) {
    return repoMap[teamId];
  }
  return null;
}

/**
 * Parse a GitHub repo URL into owner and repo.
 * Handles formats like:
 *   - github.com/owner/repo
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 */
export function parseRepoUrl(url: string): { owner: string; repo: string } {
  // Handle SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Handle HTTPS and bare formats
  const httpMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpMatch) {
    return { owner: httpMatch[1], repo: httpMatch[2] };
  }

  throw new Error(`Unable to parse GitHub repo URL: ${url}`);
}

/**
 * Parse a GitLab repo URL into namespace path and repo name.
 * Returns `{ projectPath, repo }` where `projectPath` is the full
 * namespace/group/repo path suitable for the GitLab API.
 *
 * Handles formats like:
 *   - gitlab.com/group/repo
 *   - https://gitlab.com/group/subgroup/repo
 *   - https://gitlab.com/group/repo.git
 *   - git@gitlab.com:group/repo.git
 *   - https://self-hosted.example.com/group/repo.git  (self-hosted)
 */
export function parseGitLabUrl(url: string): { projectPath: string; repo: string } {
  // Handle SSH format: git@gitlab.com:group/repo.git  (or group/subgroup/repo.git)
  const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const projectPath = sshMatch[1];
    const parts = projectPath.split("/");
    return { projectPath, repo: parts[parts.length - 1] };
  }

  // Handle HTTPS/bare formats — strip scheme, host, and leading slash
  // Supports gitlab.com as well as self-hosted instances.
  const httpMatch = url.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpMatch) {
    const projectPath = httpMatch[1];
    const parts = projectPath.split("/");
    return { projectPath, repo: parts[parts.length - 1] };
  }

  // Bare format without scheme: gitlab.com/group/repo (reject github.com)
  const bareMatch = url.match(/^(?!.*github\.com)[^/]+\/(.+?)(?:\.git)?$/);
  if (bareMatch) {
    const projectPath = bareMatch[1];
    const parts = projectPath.split("/");
    return { projectPath, repo: parts[parts.length - 1] };
  }

  throw new Error(`Unable to parse GitLab repo URL: ${url}`);
}
