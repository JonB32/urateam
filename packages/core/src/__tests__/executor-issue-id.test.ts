/**
 * Unit tests for BEC-81: Executor progress logs must include issueId.
 *
 * Verifies that executeStage() binds `issueId` to its child logger so that
 * every log line — including "stage still in progress", "stage completed", and
 * "stage failed" — carries the issueId correlation field.
 *
 * External dependencies mocked:
 *   - @anthropic-ai/claude-agent-sdk  (query — avoids real API calls)
 *   - ../executor/extract-handoff.js  (avoids git operations in the worktree)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (must be declared before any imports that use them) ─────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  // BEC-207: executor.ts also calls resolveClaudeAuth() — mock for test isolation.
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "session" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "run-bec81",
      issueId: "BEC-81",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Implemented the fix",
      filesChanged: ["src/executor/executor.ts"],
      approach: "Added issueId to child logger",
      context: {
        issueIntent: "Fix missing issueId in executor logs",
        constraints: [],
        assumptions: [],
      },
      tokenBudget: { contextTokensUsed: 500, recommendedMaxTurns: 5 },
    },
    structured: true,
    decisions: null,
  }),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import * as loggerModule from "../logger.js";
import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Constants ────────────────────────────────────────────────────────────────

const EXECUTOR_COMPONENT = "Executor";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-81",
  slug: "executor-progress-logs-missing-issueid",
  title: "Executor progress logs missing issueId",
  description: "Add issueId to the executor child logger.",
  acceptanceCriteria: ["All executor log lines include issueId"],
  labels: ["bug"],
  priority: 2,
};

const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

/** Seed the required pipeline_runs parent row so stage_runs FK is satisfied. */
async function seedPipelineRun(db: Db, runId: string, issueId: string = "BEC-81"): Promise<void> {
  await (db as any).insert(pipelineRuns).values({
    id: runId,
    issueId,
    issueTitle: testIssue.title,
    pipelineKey: "default",
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

/** Find the createLogger call that created the Executor child logger. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findExecutorLoggerCall(spy: { mock: { calls: any[] } }) {
  return spy.mock.calls.find(
    ([ctx]: [unknown]) => (ctx as Record<string, unknown>).component === EXECUTOR_COMPONENT,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("executeStage — issueId in executor logger (BEC-81)", () => {
  let db: Db;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createLoggerSpy: any;

  beforeEach(async () => {
    // Fresh in-memory SQLite DB for each test.
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
    createLoggerSpy = vi.spyOn(loggerModule, "createLogger");
  });

  // ── Test 1: createLogger is called with issueId ────────────────────────────
  it("binds issueId to the child logger alongside runId and stage", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec81");

    await executeStage({
      runId: "run-bec81",
      issueId: "BEC-81",
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/test-workdir",
      db,
    });

    const executorCall = findExecutorLoggerCall(createLoggerSpy);

    expect(executorCall).toBeDefined();
    expect(executorCall![0]).toMatchObject({
      component: EXECUTOR_COMPONENT,
      runId: "run-bec81",
      issueId: "BEC-81",
      stage: "implement",
    });
  });

  // ── Test 2: issueId present in successful completion ──────────────────────
  it("stage completed successfully while issueId is bound to the logger", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec81-complete");

    const result = await executeStage({
      runId: "run-bec81-complete",
      issueId: "BEC-81",
      stage: "triage",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/test-workdir",
      db,
    });

    expect(result.status).toBe("completed");

    // The Executor child logger must carry issueId
    const executorCall = findExecutorLoggerCall(createLoggerSpy);
    expect(executorCall![0]).toHaveProperty("issueId", "BEC-81");
  });

  // ── Test 3: issueId present when stage fails ──────────────────────────────
  it("issueId is bound to logger even when the stage fails (error path)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // Simulate an agent SDK failure
    (query as any).mockImplementation(() => {
      throw new Error("simulated SDK failure");
    });

    await seedPipelineRun(db, "run-bec81-fail");

    const result = await executeStage({
      runId: "run-bec81-fail",
      issueId: "BEC-81",
      stage: "review",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/test-workdir",
      db,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("simulated SDK failure");

    // Logger must still have been created with issueId before the failure
    const executorCall = findExecutorLoggerCall(createLoggerSpy);
    expect(executorCall).toBeDefined();
    expect(executorCall![0]).toMatchObject({
      component: EXECUTOR_COMPONENT,
      runId: "run-bec81-fail",
      issueId: "BEC-81",
      stage: "review",
    });
  });

  // ── Test 4: issueId differs between concurrent runs ───────────────────────
  it("issueId is correctly isolated per executeStage call (parallel-run safety)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await Promise.all([
      seedPipelineRun(db, "run-A", "BEC-10"),
      seedPipelineRun(db, "run-B", "BEC-20"),
    ]);

    // Run two stages in parallel with different issueIds
    await Promise.all([
      executeStage({
        runId: "run-A",
        issueId: "BEC-10",
        stage: "triage",
        sanitizedIssue: { ...testIssue, id: "BEC-10" },
        repoConfig: testRepoConfig,
        workdir: "/tmp/workdir-A",
        db,
      }),
      executeStage({
        runId: "run-B",
        issueId: "BEC-20",
        stage: "triage",
        sanitizedIssue: { ...testIssue, id: "BEC-20" },
        repoConfig: testRepoConfig,
        workdir: "/tmp/workdir-B",
        db,
      }),
    ]);

    // Collect all Executor logger calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executorCalls = createLoggerSpy.mock.calls.filter(
      ([ctx]: [unknown]) => (ctx as Record<string, unknown>).component === EXECUTOR_COMPONENT,
    );

    expect(executorCalls).toHaveLength(2);

    const issueIds = executorCalls.map(
      ([ctx]: [unknown]) => (ctx as Record<string, unknown>).issueId,
    );
    expect(issueIds).toContain("BEC-10");
    expect(issueIds).toContain("BEC-20");

    // Each call has a distinct issueId — no cross-contamination
    expect(issueIds[0]).not.toBe(issueIds[1]);
  });
});
