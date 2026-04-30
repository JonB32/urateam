import type { PluginConfig } from "@urateam/core";

/**
 * Build a PluginConfig from env vars, or return undefined if no relevant
 * vars are set. Shared between `ura dev` and `ura start` so both paths
 * honor the same opt-out knobs.
 *
 * Recognized env vars:
 *   REPO_EXCLUDE_PLUGINS=<csv>       Plugin paths to exclude from auto-
 *                                    detection. Matched against
 *                                    `PluginRecommendation.path` in
 *                                    mcp-resolver.ts (e.g. "superpowers"
 *                                    when the plugin's own workflow
 *                                    conflicts with urateam's branch
 *                                    management — see urateam#134).
 *   REPO_EXCLUDE_MCP_SERVERS=<csv>   MCP server names to exclude. Matched
 *                                    against `McpRecommendation.name`.
 *   REPO_DISABLE_PLUGIN_AUTODETECT=true
 *                                    Disable all auto-detection. Equivalent
 *                                    to `autoDetect: false` in repos.config.ts.
 *                                    Strict literal "true" only; opt-in
 *                                    flag (default = autoDetect on), so
 *                                    follows the codebase's `=== "true"`
 *                                    convention for opt-in env booleans.
 *
 * Returns `undefined` when none of the above are set, so the resulting
 * RepoConfig stays free of an empty `plugins` field.
 */
function parseCsv(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function repoPluginsFromEnv(): PluginConfig | undefined {
  const excludePluginsRaw = process.env.REPO_EXCLUDE_PLUGINS;
  const excludeMcpRaw = process.env.REPO_EXCLUDE_MCP_SERVERS;
  const autoDetectDisabled = process.env.REPO_DISABLE_PLUGIN_AUTODETECT === "true";

  if (!excludePluginsRaw && !excludeMcpRaw && !autoDetectDisabled) {
    return undefined;
  }

  const config: PluginConfig = {};
  if (excludePluginsRaw) {
    const excludePlugins = parseCsv(excludePluginsRaw);
    if (excludePlugins.length > 0) config.excludePlugins = excludePlugins;
  }
  if (excludeMcpRaw) {
    const excludeMcpServers = parseCsv(excludeMcpRaw);
    if (excludeMcpServers.length > 0) config.excludeMcpServers = excludeMcpServers;
  }
  if (autoDetectDisabled) config.autoDetect = false;

  // If after filtering we ended up with no real config, treat as not set.
  if (Object.keys(config).length === 0) return undefined;
  return config;
}
