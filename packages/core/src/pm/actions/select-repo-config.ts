import type { RepoConfig } from "../../types.js";

/**
 * BEC-177: Selects the appropriate RepoConfig for a pipeline run.
 *
 * Priority order:
 * 1. **Label-based lookup**: scan all repoConfigs entries for one whose
 *    `labelPattern` field matches the resolved pipeline label (case-insensitive).
 *    This enables multi-repo routing — e.g. "observer-fix" tickets clone the
 *    urateam-quality-observer repo while "auto-implement" tickets clone urateam.
 * 2. **TeamId fallback**: `repoConfigs[teamId]` if a key matching the Linear
 *    team ID exists (original single-repo behaviour, backwards compatible).
 * 3. **ProjectId fallback**: `repoConfigs[projectId]` if a key matching the
 *    Linear project ID exists.
 *
 * @param pipelineLabel  The resolved pipeline label (e.g. "auto-implement", "observer-fix").
 * @param teamId         Linear team ID for the issue (may be null/undefined).
 * @param projectId      Linear project ID for the issue (may be null/undefined).
 * @param repoConfigs    Map of all configured repos.
 * @returns              The matching RepoConfig, or null if no match found.
 */
export function selectRepoConfig(
  pipelineLabel: string,
  teamId: string | null | undefined,
  projectId: string | null | undefined,
  repoConfigs: Record<string, RepoConfig>,
): RepoConfig | null {
  const labelLower = pipelineLabel.toLowerCase();

  // 1. Label-pattern lookup: find first entry whose labelPattern matches
  for (const config of Object.values(repoConfigs)) {
    if (!config.labelPattern) continue;
    if (config.labelPattern.toLowerCase() === labelLower) {
      return config;
    }
  }

  // 2. TeamId key lookup (original behaviour — backwards compatible)
  if (teamId && repoConfigs[teamId]) return repoConfigs[teamId];

  // 3. ProjectId key lookup
  if (projectId && repoConfigs[projectId]) return repoConfigs[projectId];

  return null;
}
