import type { TechStackProfile } from "../repo/tech-stack.js";
import type { StageType, PluginConfig } from "../types.js";

/**
 * MCP server spec for the Agent SDK. Can be a string (server name from
 * global config) or a Record<name, config> for process-transport servers.
 */
export type McpServerSpec = string | Record<string, {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}>;

export interface PluginSpec {
  type: "local";
  path: string;
}

export interface ResolvedTools {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  plugins: PluginSpec[];
}

/**
 * Mapping of tech stack signals to recommended MCP servers.
 * Each entry specifies a server config and which stages benefit from it.
 */
interface McpRecommendation {
  /** MCP server name */
  name: string;
  /** Server config */
  config: { command: string; args?: string[]; env?: Record<string, string> };
  /** Which tech stack signals trigger this server */
  triggers: {
    languages?: string[];
    frameworks?: string[];
  };
  /** Which stages should include this server. Empty = all stages. */
  stages?: StageType[];
}

/**
 * Mapping of tech stack signals to recommended plugins.
 */
interface PluginRecommendation {
  name: string;
  path: string;
  triggers: {
    languages?: string[];
    frameworks?: string[];
  };
  stages?: StageType[];
}

// MCP servers that provide value for specific tech stacks
const MCP_RECOMMENDATIONS: McpRecommendation[] = [
  // Context7 - documentation lookup for any project
  {
    name: "context7",
    config: { command: "npx", args: ["-y", "@upstash/context7-mcp@1"] },
    triggers: {},  // Always useful
    stages: ["triage", "implement", "reproduce"],
  },
];

// Plugin recommendations mapped to tech stacks
const PLUGIN_RECOMMENDATIONS: PluginRecommendation[] = [
  // Superpowers is useful for all projects
  {
    name: "superpowers",
    path: "superpowers",
    triggers: {},
    stages: ["implement", "test", "review"],
  },
];


function matchesTrigger(
  techStack: TechStackProfile,
  triggers: { languages?: string[]; frameworks?: string[] },
): boolean {
  // Empty triggers = always matches
  if (!triggers.languages?.length && !triggers.frameworks?.length) return true;

  if (triggers.languages?.some((l) => techStack.languages.includes(l))) return true;
  if (triggers.frameworks?.some((f) => techStack.frameworks.includes(f))) return true;
  return false;
}

/**
 * Resolve MCP servers and plugins for a given stage based on the project's
 * tech stack. Applies explicit includes/excludes from plugin config.
 */
export function resolveTooling(
  techStack: TechStackProfile,
  stage: StageType,
  pluginConfig?: PluginConfig,
): ResolvedTools {
  const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  const plugins: PluginSpec[] = [];

  const autoDetect = pluginConfig?.autoDetect !== false;
  const excludeMcp = new Set(pluginConfig?.excludeMcpServers ?? []);
  const excludePlugins = new Set(pluginConfig?.excludePlugins ?? []);

  if (autoDetect) {
    // Auto-detect MCP servers
    for (const rec of MCP_RECOMMENDATIONS) {
      if (excludeMcp.has(rec.name)) continue;
      if (rec.stages?.length && !rec.stages.includes(stage)) continue;
      if (!matchesTrigger(techStack, rec.triggers)) continue;
      mcpServers[rec.name] = rec.config;
    }

    // Auto-detect plugins (exclude by path for consistency with explicit plugins)
    for (const rec of PLUGIN_RECOMMENDATIONS) {
      if (excludePlugins.has(rec.path)) continue;
      if (rec.stages?.length && !rec.stages.includes(stage)) continue;
      if (!matchesTrigger(techStack, rec.triggers)) continue;
      plugins.push({ type: "local", path: rec.path });
    }
  }

  // Add explicit includes (always, regardless of autoDetect)
  if (pluginConfig?.mcpServers) {
    for (const [name, config] of Object.entries(pluginConfig.mcpServers)) {
      if (!excludeMcp.has(name)) {
        mcpServers[name] = config;
      }
    }
  }
  if (pluginConfig?.plugins) {
    for (const plugin of pluginConfig.plugins) {
      if (!excludePlugins.has(plugin.path)) {
        plugins.push(plugin);
      }
    }
  }

  return { mcpServers, plugins };
}
