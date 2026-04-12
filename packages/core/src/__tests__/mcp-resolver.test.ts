import { describe, it, expect } from "vitest";
import { resolveTooling } from "../executor/mcp-resolver.js";
import type { TechStackProfile } from "../repo/tech-stack.js";

function makeProfile(overrides?: Partial<TechStackProfile>): TechStackProfile {
  return {
    languages: [],
    frameworks: [],
    buildSystems: [],
    hasDevcontainer: false,
    ...overrides,
  };
}

describe("resolveTooling", () => {
  it("returns context7 MCP server for implement stage", () => {
    const result = resolveTooling(makeProfile({ languages: ["typescript"] }), "implement");
    expect(result.mcpServers).toHaveProperty("context7");
  });

  it("does not include context7 for review stage", () => {
    const result = resolveTooling(makeProfile({ languages: ["typescript"] }), "review");
    expect(result.mcpServers).not.toHaveProperty("context7");
  });

  it("includes superpowers plugin for implement stage", () => {
    const result = resolveTooling(makeProfile(), "implement");
    expect(result.plugins).toContainEqual({ type: "local", path: "superpowers" });
  });

  it("does not include superpowers plugin for triage stage", () => {
    const result = resolveTooling(makeProfile(), "triage");
    expect(result.plugins).not.toContainEqual(expect.objectContaining({ path: "superpowers" }));
  });

  it("respects excludeMcpServers", () => {
    const result = resolveTooling(
      makeProfile({ languages: ["typescript"] }),
      "implement",
      { excludeMcpServers: ["context7"] },
    );
    expect(result.mcpServers).not.toHaveProperty("context7");
  });

  it("respects excludePlugins", () => {
    const result = resolveTooling(
      makeProfile(),
      "implement",
      { excludePlugins: ["superpowers"] },
    );
    expect(result.plugins).not.toContainEqual(expect.objectContaining({ path: "superpowers" }));
  });

  it("adds explicit MCP servers from config", () => {
    const result = resolveTooling(
      makeProfile(),
      "triage",
      {
        mcpServers: {
          "custom-server": { command: "node", args: ["server.js"] },
        },
      },
    );
    expect(result.mcpServers).toHaveProperty("custom-server");
  });

  it("adds explicit plugins from config", () => {
    const result = resolveTooling(
      makeProfile(),
      "triage",
      {
        plugins: [{ type: "local", path: "/path/to/plugin" }],
      },
    );
    expect(result.plugins).toContainEqual({ type: "local", path: "/path/to/plugin" });
  });

  it("disables auto-detection when autoDetect is false", () => {
    const result = resolveTooling(
      makeProfile({ languages: ["typescript"] }),
      "implement",
      { autoDetect: false },
    );
    // No auto-detected servers
    expect(Object.keys(result.mcpServers)).toHaveLength(0);
    expect(result.plugins).toHaveLength(0);
  });

  it("still includes explicit servers when autoDetect is false", () => {
    const result = resolveTooling(
      makeProfile(),
      "implement",
      {
        autoDetect: false,
        mcpServers: { "my-server": { command: "node", args: ["s.js"] } },
      },
    );
    expect(result.mcpServers).toHaveProperty("my-server");
  });
});
