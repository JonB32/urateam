import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  filterPipelineToStage,
  resolveRepoConfig,
  createConsoleNotifier,
} from "../commands/run.js";
import type { PipelineConfig, RepoConfig } from "@urateam/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bugPipeline: PipelineConfig = {
  name: "Bug Fix",
  stages: ["reproduce", "implement", "test", "review"],
  retry: { maxAttempts: 2, strategy: "fix-and-retry" },
  review: { requiredApprovals: 1 },
  prStrategy: "draft",
};

const featurePipeline: PipelineConfig = {
  name: "Feature",
  stages: ["implement", "test", "review"],
  retry: { maxAttempts: 1, strategy: "escalate" },
  review: { requiredApprovals: 1 },
  prStrategy: "draft",
};

const repoConfig: RepoConfig = {
  url: "https://github.com/org/my-app",
  defaultBranch: "main",
  testCommand: "pnpm test",
  buildCommand: "pnpm build",
};

// ---------------------------------------------------------------------------
// filterPipelineToStage
// ---------------------------------------------------------------------------

describe("filterPipelineToStage", () => {
  it("returns a config with stages limited to the specified stage", () => {
    const filtered = filterPipelineToStage(bugPipeline, "implement");
    expect(filtered.stages).toEqual(["implement"]);
  });

  it("preserves all other pipeline properties", () => {
    const filtered = filterPipelineToStage(bugPipeline, "test");
    expect(filtered.name).toBe(bugPipeline.name);
    expect(filtered.retry).toEqual(bugPipeline.retry);
    expect(filtered.review).toEqual(bugPipeline.review);
    expect(filtered.prStrategy).toBe(bugPipeline.prStrategy);
  });

  it("does not mutate the original config", () => {
    filterPipelineToStage(bugPipeline, "review");
    expect(bugPipeline.stages).toHaveLength(4);
  });

  it("throws when the stage is not in the pipeline", () => {
    expect(() => filterPipelineToStage(featurePipeline, "reproduce")).toThrow(
      /stage "reproduce" is not in pipeline/i,
    );
  });

  it("includes the stage name and available stages in the error", () => {
    expect(() => filterPipelineToStage(bugPipeline, "triage")).toThrow(
      /triage/,
    );
  });

  it("works for all stages in a pipeline", () => {
    for (const stage of bugPipeline.stages) {
      const filtered = filterPipelineToStage(bugPipeline, stage);
      expect(filtered.stages).toEqual([stage]);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveRepoConfig
// ---------------------------------------------------------------------------

describe("resolveRepoConfig", () => {
  const repoConfigs: Record<string, RepoConfig> = {
    "team-123": repoConfig,
    "team-456": {
      ...repoConfig,
      url: "https://github.com/org/other-app",
    },
  };

  it("returns the config matching the teamId", () => {
    const result = resolveRepoConfig(repoConfigs, "team-123");
    expect(result?.url).toBe("https://github.com/org/my-app");
  });

  it("returns the config for a different teamId", () => {
    const result = resolveRepoConfig(repoConfigs, "team-456");
    expect(result?.url).toBe("https://github.com/org/other-app");
  });

  it("falls back to the first config when teamId is not found", () => {
    const result = resolveRepoConfig(repoConfigs, "team-unknown");
    expect(result).not.toBeNull();
    // Should return one of the two configs (the first key)
    expect(["https://github.com/org/my-app", "https://github.com/org/other-app"]).toContain(
      result?.url,
    );
  });

  it("returns null when repoConfigs is empty", () => {
    const result = resolveRepoConfig({}, "team-123");
    expect(result).toBeNull();
  });

  it("returns the only config regardless of teamId", () => {
    const single = { "team-abc": repoConfig };
    const result = resolveRepoConfig(single, "team-xyz");
    expect(result?.url).toBe(repoConfig.url);
  });
});

// ---------------------------------------------------------------------------
// createConsoleNotifier
// ---------------------------------------------------------------------------

describe("createConsoleNotifier", () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  const fakeRun: any = {
    id: "abc12345xyz",
    issueId: "LIN-42",
    branch: "agent/LIN-42-fix",
    pipelineKey: "bug",
    repoUrl: "https://github.com/org/app",
    status: "running",
  };

  it("logs on pipeline start", async () => {
    const notifier = createConsoleNotifier();
    await notifier.onPipelineStart!(fakeRun);
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Pipeline started"),
    );
  });

  it("logs stage completion with ✅ on success", async () => {
    const notifier = createConsoleNotifier();
    await notifier.onStageComplete!(fakeRun, "implement", {
      status: "completed",
      inputTokens: 100,
      outputTokens: 200,
      turns: 1,
    } as any);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("✅"));
  });

  it("logs stage completion with ❌ on failure", async () => {
    const notifier = createConsoleNotifier();
    await notifier.onStageComplete!(fakeRun, "test", {
      status: "failed",
      inputTokens: 50,
      outputTokens: 75,
      turns: 1,
    } as any);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("❌"));
  });

  it("logs pipeline complete with PR URL when present", async () => {
    const notifier = createConsoleNotifier();
    await notifier.onPipelineComplete!(fakeRun, {
      prUrl: "https://github.com/org/app/pull/42",
      stagesCompleted: 3,
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
    } as any);
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("complete"));
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("https://github.com/org/app/pull/42"),
    );
  });

  it("logs pipeline failure with stage and message", async () => {
    const notifier = createConsoleNotifier();
    await notifier.onPipelineFailed!(fakeRun, {
      stage: "implement",
      message: "out of retries",
      retriesExhausted: true,
    } as any);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("failed"));
  });

  it("logs human review needed with PR URL", async () => {
    const notifier = createConsoleNotifier();
    await notifier.onHumanReviewNeeded!(
      fakeRun,
      "https://github.com/org/app/pull/99",
      "blocking findings",
    );
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Human review needed"),
    );
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("https://github.com/org/app/pull/99"),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration wiring: run command action (mocked Linear client + executor)
// ---------------------------------------------------------------------------

describe("run command — auth error", () => {
  let origEnv: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExit: any;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    origEnv = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: any) => {
        throw new Error(`process.exit(${_code})`);
      });
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.LINEAR_API_KEY = origEnv;
    } else {
      delete process.env.LINEAR_API_KEY;
    }
    processExit.mockRestore();
    consoleError.mockRestore();
  });

  it("surfaces a clear actionable message when LINEAR_API_KEY is missing", async () => {
    const { runCommand } = await import("../commands/run.js");
    // Parse with the --issue flag (required) and trigger the action
    await expect(
      runCommand.parseAsync(["--issue", "LIN-1"], { from: "user" }),
    ).rejects.toThrow("process.exit(1)");

    // Check that a helpful message was printed
    const errorMessages = consoleError.mock.calls.map((c) => c.join(" "));
    expect(
      errorMessages.some((m) => m.includes("LINEAR_API_KEY")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dry-run wiring: resolves pipeline from mocked configs + mock Linear issue
// ---------------------------------------------------------------------------

describe("run command — dry run wiring", () => {
  let origKey: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExit: any;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(async () => {
    origKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test_key";

    // Create a temporary directory for config files
    tmpDir = join(tmpdir(), `lag-test-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });

    processExit = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: any) => {
        throw new Error(`process.exit(${_code})`);
      });
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (origKey !== undefined) {
      process.env.LINEAR_API_KEY = origKey;
    } else {
      delete process.env.LINEAR_API_KEY;
    }
    processExit.mockRestore();
    consoleLog.mockRestore();
    consoleError.mockRestore();
    await rm(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("prints dry-run plan when Linear issue resolves to a known pipeline", async () => {
    // Write minimal config files
    await writeFile(
      join(tmpDir, "pipeline.config.mjs"),
      `export const pipelines = {
  "auto-implement": {
    name: "Auto Implement",
    stages: ["implement", "test", "review"],
    retry: { maxAttempts: 2, strategy: "fix-and-retry" },
    review: { requiredApprovals: 1 },
    prStrategy: "draft",
  },
};`,
    );
    await writeFile(
      join(tmpDir, "repos.config.mjs"),
      `export const repos = {
  "team-abc": {
    url: "https://github.com/org/app",
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
  },
};`,
    );

    // Mock @linear/sdk — use doMock (not hoisted) so it applies after resetModules
    vi.doMock("@linear/sdk", () => ({
      LinearClient: vi.fn().mockImplementation(() => ({
        issue: vi.fn().mockResolvedValue({
          id: "issue-uuid",
          identifier: "LIN-99",
          title: "Test issue",
          description: "A test issue",
          priority: 2,
          team: Promise.resolve({ id: "team-abc" }),
          project: Promise.resolve(null),
          labels: vi.fn().mockResolvedValue({
            nodes: [{ name: "auto-implement" }],
          }),
        }),
      })),
    }));

    const { runCommand } = await import("../commands/run.js");

    await runCommand.parseAsync(
      [
        "--issue",
        "LIN-99",
        "--dry-run",
        "--config",
        join(tmpDir, "pipeline.config.mjs"),
        "--repos",
        join(tmpDir, "repos.config.mjs"),
      ],
      { from: "user" },
    );

    const logOutput = consoleLog.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toMatch(/Dry Run/i);
    expect(logOutput).toMatch(/LIN-99/);
    expect(logOutput).toMatch(/auto-implement/i);
    expect(logOutput).toMatch(/implement.*test.*review/i);
  });
});
