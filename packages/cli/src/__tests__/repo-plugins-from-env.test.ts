import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { repoPluginsFromEnv } from "../lib/repo-plugins-from-env.js";

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

  it("does NOT set autoDetect when REPO_DISABLE_PLUGIN_AUTODETECT is anything other than 'true'", () => {
    // Defensive: only the explicit string 'true' disables auto-detect, so a
    // typo like '1' or 'yes' doesn't silently change behavior.
    process.env.REPO_DISABLE_PLUGIN_AUTODETECT = "yes";
    expect(repoPluginsFromEnv()).toBeUndefined();
    process.env.REPO_DISABLE_PLUGIN_AUTODETECT = "1";
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
});
