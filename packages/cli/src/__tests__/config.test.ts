import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @urateam/core before any imports that might resolve it
vi.mock("@urateam/core", () => ({
  validatePipelineConfigs: vi.fn((configs: unknown) => configs),
  validateRepoConfigs: vi.fn((configs: unknown) => configs),
  defaultConfigs: {
    default: {
      name: "default",
      stages: ["triage", "implement", "test", "review"],
    },
  },
}));

import { configCommand } from "../commands/config.js";

describe("lag config validate", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errorSpy: any;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports default pipeline config when no custom config file exists", async () => {
    await configCommand.parseAsync([
      "node",
      "ura",
      "validate",
      "--pipeline",
      "./nonexistent-pipeline.config.ts",
      "--repos",
      "./nonexistent-repos.config.ts",
    ]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Validating configurations"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No custom pipeline config found"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Configuration is valid"),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reports that no repo config was found when file is missing", async () => {
    await configCommand.parseAsync([
      "node",
      "ura",
      "validate",
      "--pipeline",
      "./nonexistent-pipeline.config.ts",
      "--repos",
      "./nonexistent-repos.config.ts",
    ]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("No repo config found"),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("lists default pipeline names after loading defaults", async () => {
    await configCommand.parseAsync([
      "node",
      "ura",
      "validate",
      "--pipeline",
      "./nonexistent-pipeline.config.ts",
    ]);

    // Should list the pipeline keys from defaultConfigs
    const pipelineLogCall = logSpy.mock.calls.find((args: unknown[]) =>
      String(args[0]).includes("Pipelines:"),
    );
    expect(pipelineLogCall).toBeDefined();
    expect(String(pipelineLogCall![0])).toContain("default");
  });

  it("exits with code 1 for unknown actions", async () => {
    await configCommand.parseAsync([
      "node",
      "ura",
      "unknown-action",
      "--pipeline",
      "./nonexistent-pipeline.config.ts",
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unknown action"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("defaults to validate action when no action argument is given", async () => {
    await configCommand.parseAsync([
      "node",
      "ura",
      "--pipeline",
      "./nonexistent-pipeline.config.ts",
    ]);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Validating configurations"),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
