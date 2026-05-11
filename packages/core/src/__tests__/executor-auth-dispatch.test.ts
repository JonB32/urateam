/**
 * Executor auth dispatch tests (BEC-207, AC #12, #13).
 *
 * Exercises executeStage() with all three Claude authentication methods to
 * verify the executor correctly resolves auth, skips subprocesses for env-var
 * paths, and proceeds to the Agent SDK in each scenario.
 *
 * Mocks:
 *  - @anthropic-ai/claude-agent-sdk — returns a minimal stream (no real API)
 *  - ../executor/extract-handoff.js — returns a stub artifact (no git deps)
 *  - node:child_process — controls isClaudeAuthValid() subprocess behaviour
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Hoisted mock state (must be declared before vi.mock factories reference them)
// ---------------------------------------------------------------------------
const { mockQueryFn, mockExecFile } = vi.hoisted(() => ({
  mockQueryFn: vi.fn(),
  mockExecFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Static mocks (hoisted by Vitest — available to dynamic imports too)
// ---------------------------------------------------------------------------

// Mock the Agent SDK so no real API calls are made.
// executor.ts calls `const { query } = await import("@anthropic-ai/claude-agent-sdk")`
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQueryFn,
}));

// Mock child_process.execFile — used by isClaudeAuthValid() for the session path.
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// Mock extractHandoff to avoid real git operations.
vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    structured: false,
    artifact: {
      runId: "run-auth-test",
      issueId: "BEC-207",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Auth dispatch test stub",
      filesChanged: [],
      approach: "stub",
      context: { issueIntent: "test", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 10 },
    },
  }),
}));

// ---------------------------------------------------------------------------
// Static imports (mocks in place)
// ---------------------------------------------------------------------------
import { executeStage } from "../executor/executor.js";
import { resetAuthCheckCache } from "../executor/auth-check.js";
import { createDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal sanitized issue fixture */
const testIssue: SanitizedIssue = {
  id: "BEC-207",
  slug: "auth-dispatch-test",
  title: "Auth dispatch test",
  description: "Verify executor auth dispatch for BEC-207.",
  acceptanceCriteria: ["Auth dispatches correctly"],
  labels: ["auto-implement"],
  priority: 2,
};

/** Minimal repo config */
const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

/**
 * Create an async generator that yields a minimal assistant message and
 * finishes — simulating a successful one-turn Agent SDK response.
 */
async function* makeMinimalStream(): AsyncIterable<unknown> {
  yield {
    type: "assistant",
    usage: { input_tokens: 100, output_tokens: 50 },
    content: [{ type: "text", text: "Implementation complete." }],
  };
}

// ---------------------------------------------------------------------------
// Tests: executeStage() with each auth method
// ---------------------------------------------------------------------------

describe("executeStage() — Claude auth method dispatch (BEC-207, AC #12)", () => {
  let workdir: string;
  let db: Awaited<ReturnType<typeof createDb>>;
  let savedOauthToken: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    // Reset auth check cache so each test starts clean
    resetAuthCheckCache();
    mockQueryFn.mockReset();
    mockExecFile.mockReset();

    // Provide the minimal stream by default
    mockQueryFn.mockReturnValue(makeMinimalStream());

    // Save and clear env vars
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;

    // Create a temp workdir (SDK mock doesn't use it, but executor expects a path)
    workdir = mkdtempSync(join(tmpdir(), "exec-auth-test-"));

    // In-memory SQLite DB
    db = await createDb({ connectionString: ":memory:" });

    // Seed a pipeline_runs parent row (stageRuns FK requires it)
    await (db as any).insert(pipelineRuns).values({
      id: "run-auth-test",
      issueId: testIssue.id,
      issueTitle: testIssue.title,
      pipelineKey: "default",
      repoUrl: testRepoConfig.url,
      branch: "agent/BEC-207-auth-dispatch-test",
      status: "running",
    });
  });

  afterEach(() => {
    // Restore env vars
    if (savedOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    }
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
    // Clean up temp dir
    try { rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // AC #12a — CLAUDE_CODE_OAUTH_TOKEN path
  // -------------------------------------------------------------------------
  it("succeeds with CLAUDE_CODE_OAUTH_TOKEN set (oauth-token path)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test-token";

    const result = await executeStage({
      runId: "run-auth-test",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir,
      db: db as any,
    });

    // Stage must complete without error
    expect(result.status).toBe("completed");
    // Token counts come from the mock stream
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    // Agent SDK was invoked
    expect(mockQueryFn).toHaveBeenCalledTimes(1);
    // No subprocess for auth check (env var path)
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AC #12b — ANTHROPIC_API_KEY path
  // -------------------------------------------------------------------------
  it("succeeds with ANTHROPIC_API_KEY set (api-key path)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";

    const result = await executeStage({
      runId: "run-auth-test",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir,
      db: db as any,
    });

    expect(result.status).toBe("completed");
    expect(mockQueryFn).toHaveBeenCalledTimes(1);
    // Still no subprocess for api-key path
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // AC #12c — Mounted session path (neither env var set)
  // -------------------------------------------------------------------------
  it("succeeds with neither env var set (mounted session path — subprocess valid)", async () => {
    // Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY — deleted in beforeEach.
    // Simulate a valid CLI session via the mocked execFile.
    mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null) => void) => {
      cb(null); // successful `claude auth status`
      return {} as any;
    });

    const result = await executeStage({
      runId: "run-auth-test",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir,
      db: db as any,
    });

    expect(result.status).toBe("completed");
    expect(mockQueryFn).toHaveBeenCalledTimes(1);
    // The subprocess MUST have been called for the session path
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      "claude",
      ["auth", "status"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  // -------------------------------------------------------------------------
  // AC #12d — Mounted session path: expired session → stage fails fast
  // -------------------------------------------------------------------------
  it("returns failed result when mounted session is expired (neither env var set)", async () => {
    // Simulate expired session
    mockExecFile.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
      cb(new Error("not logged in"));
      return {} as any;
    });

    const result = await executeStage({
      runId: "run-auth-test",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir,
      db: db as any,
    });

    // Should fail fast with an auth error rather than calling the SDK
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("invalid or expired");
    // Agent SDK must NOT have been called
    expect(mockQueryFn).not.toHaveBeenCalled();
  });
});
