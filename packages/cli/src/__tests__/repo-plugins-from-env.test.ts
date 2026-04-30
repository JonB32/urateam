import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { repoPluginsFromEnv } from "../lib/repo-plugins-from-env.js";
import { PluginConfigSchema } from "@urateam/core";

const RELEVANT_VARS = [
  "REPO_EXCLUDE_PLUGINS",
  "REPO_EXCLUDE_MCP_SERVERS",
  "REPO_DISABLE_PLUGIN_AUTODETECT",
] as const;

describe("repoPluginsFromEnv", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(RELEVANT_VARS.map((k) => [k, process.env[k]]));
    for (const k of RELEVANT_VARS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of RELEVANT_VARS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  it("returns undefined when no relevant env vars are set", () => {
    expect(repoPluginsFromEnv()).toBeUndefined();
  });

  it("parses REPO_EXCLUDE_PLUGINS as a csv into excludePlugins", () => {
    process.env.REPO_EXCLUDE_PLUGINS = "superpowers,foo-skill";
    expect(repoPluginsFromEnv()).toEqual({
      excludePlugins: ["superpowers", "foo-skill"],
    });
  });

  it("trims whitespace + drops empty entries from REPO_EXCLUDE_PLUGINS", () => {
    process.env.REPO_EXCLUDE_PLUGINS = "  superpowers ,  ,foo  ,";
    expect(repoPluginsFromEnv()).toEqual({
      excludePlugins: ["superpowers", "foo"],
    });
  });

  it("returns undefined when the csv is just whitespace/commas (no real entries)", () => {
    process.env.REPO_EXCLUDE_PLUGINS = "  ,  ,  ";
    expect(repoPluginsFromEnv()).toBeUndefined();
  });

  it("parses REPO_EXCLUDE_MCP_SERVERS into excludeMcpServers", () => {
    process.env.REPO_EXCLUDE_MCP_SERVERS = "context7,linear";
    expect(repoPluginsFromEnv()).toEqual({
      excludeMcpServers: ["context7", "linear"],
    });
  });

  it("treats REPO_DISABLE_PLUGIN_AUTODETECT=true as autoDetect:false", () => {
    process.env.REPO_DISABLE_PLUGIN_AUTODETECT = "true";
    expect(repoPluginsFromEnv()).toEqual({ autoDetect: false });
  });

  it("requires literal 'true' for REPO_DISABLE_PLUGIN_AUTODETECT (codebase convention for opt-in env booleans)", () => {
    // Documents current behavior — opt-in flags use `=== "true"` (vs.
    // opt-out flags like GITHUB_FEEDBACK_AUTO_TRIGGER which use `!== "false"`).
    // If we ever relax this to also accept "1"/"yes"/etc., update this test.
    process.env.REPO_DISABLE_PLUGIN_AUTODETECT = "false";
    expect(repoPluginsFromEnv()).toBeUndefined();
    process.env.REPO_DISABLE_PLUGIN_AUTODETECT = "";
    expect(repoPluginsFromEnv()).toBeUndefined();
  });

  it("combines all three env vars into a single PluginConfig", () => {
    process.env.REPO_EXCLUDE_PLUGINS = "superpowers";
    process.env.REPO_EXCLUDE_MCP_SERVERS = "context7";
    process.env.REPO_DISABLE_PLUGIN_AUTODETECT = "true";
    expect(repoPluginsFromEnv()).toEqual({
      excludePlugins: ["superpowers"],
      excludeMcpServers: ["context7"],
      autoDetect: false,
    });
  });

  it("output round-trips through the canonical PluginConfig zod schema in core", () => {
    // Integration boundary: the helper builds a `PluginConfig` literal, but
    // the actual contract is defined by `PluginConfigSchema` in
    // packages/core/src/types.ts. Validating against the schema catches any
    // future drift between the helper's shape and what the runtime expects
    // (which is what the `repoEntry.plugins = pluginCfg` wiring in start.ts
    // and dev.ts ultimately feeds into mcp-resolver.ts).
    process.env.REPO_EXCLUDE_PLUGINS = "superpowers,foo";
    process.env.REPO_EXCLUDE_MCP_SERVERS = "context7";
    process.env.REPO_DISABLE_PLUGIN_AUTODETECT = "true";
    const cfg = repoPluginsFromEnv();
    expect(cfg).toBeDefined();
    expect(() => PluginConfigSchema.parse(cfg)).not.toThrow();
  });
});
