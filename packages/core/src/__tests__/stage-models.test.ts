/**
 * Tests for BEC-82: Per-stage model override in pipeline config.
 *
 * Verifies:
 *   1. PipelineConfigSchema accepts optional stageModels field.
 *   2. executeStage() passes the stageModels override to the Agent SDK query.
 *   3. Default (profile) model is used when stageModels is absent or lacks the stage key.
 *
 * External dependencies mocked:
 *   - @anthropic-ai/claude-agent-sdk  (query — avoids real API calls)
 *   - ../executor/extract-handoff.js  (avoids git operations in the worktree)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (must be declared before imports that use them) ──────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  // BEC-207: executor.ts also calls resolveClaudeAuth() to log the active
  // auth method. Mock returns the "session" default so the test doesn't
  // depend on env vars.
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "session" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "run-bec82",
      issueId: "BEC-82",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Implemented the fix",
      filesChanged: ["src/executor/executor.ts"],
      approach: "Added stageModels support",
      context: {
        issueIntent: "Allow per-stage model override",
        constraints: [],
        assumptions: [],
      },
      tokenBudget: { contextTokensUsed: 500, recommendedMaxTurns: 5 },
    },
    structured: true,
    decisions: null,
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import { PipelineConfigSchema } from "../types.js";
import { DEFAULT_MODEL, HAIKU_MODEL } from "../executor/profiles.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-82",
  slug: "allow-per-stage-model-override",
  title: "Allow per-stage model override in pipeline config",
  description: "Support stageModels in PipelineConfig.",
  acceptanceCriteria: ["stageModels overrides profile model per stage"],
  labels: ["auto-implement"],
  priority: 4,
};

const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

/** Seed the required pipeline_runs parent row so stage_runs FK is satisfied. */
async function seedPipelineRun(db: Db, runId: string): Promise<void> {
  await (db as any).insert(pipelineRuns).values({
    id: runId,
    issueId: testIssue.id,
    issueTitle: testIssue.title,
    pipelineKey: "auto-implement",
    repoUrl: testRepoConfig.url,
    branch: `agent/${runId}`,
    status: "running",
  });
}

/** A minimal async-generator that produces one assistant message and then ends. */
function makeMinimalStream() {
  return (async function* () {
    yield {
      type: "assistant",
      content: [{ type: "text", text: "Implementation complete." }],
    };
  })();
}

// ── Tests: PipelineConfigSchema ───────────────────────────────────────────────

describe("PipelineConfigSchema — stageModels field", () => {
  const baseConfig = {
    name: "Test",
    stages: ["implement", "test"] as const,
    retry: { maxAttempts: 1, strategy: "fail-fast" as const },
    review: { requiredApprovals: 0 },
    prStrategy: "draft" as const,
  };

  it("accepts a config without stageModels (field is optional)", () => {
    const result = PipelineConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    expect(result.data?.stageModels).toBeUndefined();
  });

  it("accepts a config with an empty stageModels map", () => {
    const result = PipelineConfigSchema.safeParse({
      ...baseConfig,
      stageModels: {},
    });
    expect(result.success).toBe(true);
    expect(result.data?.stageModels).toEqual({});
  });

  it("accepts a config with a valid stageModels override", () => {
    const result = PipelineConfigSchema.safeParse({
      ...baseConfig,
      stageModels: {
        implement: "claude-opus-4-6",
        test: "claude-haiku-4-5",
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.stageModels).toEqual({
      implement: "claude-opus-4-6",
      test: "claude-haiku-4-5",
    });
  });

  it("accepts arbitrary model strings (no local validation — let SDK error)", () => {
    // Invalid model strings must not be rejected by the schema
    const result = PipelineConfigSchema.safeParse({
      ...baseConfig,
      stageModels: {
        implement: "some-totally-unknown-model-string",
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.stageModels?.implement).toBe(
      "some-totally-unknown-model-string",
    );
  });

  it("rejects stageModels when a value is not a string", () => {
    const result = PipelineConfigSchema.safeParse({
      ...baseConfig,
      stageModels: {
        implement: 42, // number, not string
      },
    });
    expect(result.success).toBe(false);
  });
});

// ── Tests: executeStage model resolution ─────────────────────────────────────

describe("executeStage — stageModels model resolution (BEC-82)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
  });

  it("passes profile.model to query when stageModels is not provided", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec82-default");

    await executeStage({
      runId: "run-bec82-default",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec82-workdir",
      db,
      // stageModels omitted — should fall back to profile.model
    });

    expect(query).toHaveBeenCalledOnce();
    const callOptions = (query as any).mock.calls[0][0].options;
    // implement profile uses DEFAULT_MODEL
    expect(callOptions.model).toBe(DEFAULT_MODEL);
  });

  it("uses the stageModels override instead of profile.model when provided for the stage", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec82-override");

    await executeStage({
      runId: "run-bec82-override",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec82-workdir",
      db,
      stageModels: { implement: "claude-opus-4-6" },
    });

    expect(query).toHaveBeenCalledOnce();
    const callOptions = (query as any).mock.calls[0][0].options;
    expect(callOptions.model).toBe("claude-opus-4-6");
  });

  it("falls back to profile.model when stageModels does not contain the current stage", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec82-fallback");

    await executeStage({
      runId: "run-bec82-fallback",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec82-workdir",
      db,
      // stageModels only has "test" — "implement" should fall back to profile
      stageModels: { test: "claude-opus-4-6" },
    });

    expect(query).toHaveBeenCalledOnce();
    const callOptions = (query as any).mock.calls[0][0].options;
    // implement profile default is DEFAULT_MODEL
    expect(callOptions.model).toBe(DEFAULT_MODEL);
  });

  it("respects stageModels override for the test stage (overriding HAIKU_MODEL default)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec82-test-stage");

    await executeStage({
      runId: "run-bec82-test-stage",
      issueId: testIssue.id,
      stage: "test",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec82-workdir",
      db,
      stageModels: { test: "claude-sonnet-4-6" }, // override Haiku with Sonnet
    });

    expect(query).toHaveBeenCalledOnce();
    const callOptions = (query as any).mock.calls[0][0].options;
    // Should be the override, not the profile default (HAIKU_MODEL)
    expect(callOptions.model).toBe("claude-sonnet-4-6");
    expect(callOptions.model).not.toBe(HAIKU_MODEL);
  });

  it("test stage uses HAIKU_MODEL by default (no stageModels)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec82-haiku-default");

    await executeStage({
      runId: "run-bec82-haiku-default",
      issueId: testIssue.id,
      stage: "test",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec82-workdir",
      db,
      // No stageModels — test profile should use HAIKU_MODEL
    });

    expect(query).toHaveBeenCalledOnce();
    const callOptions = (query as any).mock.calls[0][0].options;
    expect(callOptions.model).toBe(HAIKU_MODEL);
  });
});
