import type { PluginConfig } from "@urateam/core";

/**
 * Build a PluginConfig from env vars, or return undefined if no relevant
 * vars are set. Shared between `ura dev` and `ura start` so both paths
 * honor the same opt-out knobs.
 *
 * Recognized env vars:
 *   REPO_EXCLUDE_PLUGINS=<csv>       Plugin names/paths to exclude from
 *                                    auto-detection (e.g. "superpowers"
 *                                    when the plugin's own workflow
 *                                    conflicts with urateam's branch
 *                                    management — see urateam#134).
 *   REPO_EXCLUDE_MCP_SERVERS=<csv>   MCP server names to exclude.
 *   REPO_DISABLE_PLUGIN_AUTODETECT=true
 *                                    Disable all auto-detection. Equivalent
 *                                    to setting `autoDetect: false` in a
 *                                    repos.config.ts plugin config.
 *
 * Returns `undefined` when none of the above are set, so the resulting
 * RepoConfig stays free of an empty `plugins` field.
 */
export function repoPluginsFromEnv(): PluginConfig | undefined {
  const excludePluginsRaw = process.env.REPO_EXCLUDE_PLUGINS;
  const excludeMcpRaw = process.env.REPO_EXCLUDE_MCP_SERVERS;
  const autoDetectDisabled = process.env.REPO_DISABLE_PLUGIN_AUTODETECT === "true";

  if (!excludePluginsRaw && !excludeMcpRaw && !autoDetectDisabled) {
    return undefined;
  }

  const config: PluginConfig = {};
  if (excludePluginsRaw) {
    const excludePlugins = excludePluginsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (excludePlugins.length > 0) config.excludePlugins = excludePlugins;
  }
  if (excludeMcpRaw) {
    const excludeMcpServers = excludeMcpRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (excludeMcpServers.length > 0) config.excludeMcpServers = excludeMcpServers;
  }
  if (autoDetectDisabled) config.autoDetect = false;

  // If after filtering we ended up with no real config, treat as not set.
  if (Object.keys(config).length === 0) return undefined;
  return config;
}
