/**
 * Reproduction test for BEC-251:
 * "Claude Code process exited with code 1" failures swallow all diagnostic detail.
 *
 * This test confirms the bug exists: when the Agent SDK throws a process-exit
 * error, the executor only stores error.message in agent_logs.content —
 * discarding exitCode, stderr, session type, auth method, and duration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before imports) ────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "api-key" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "run-bec251",
      issueId: "BEC-251",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "stub",
      filesChanged: [],
      approach: "stub",
      context: { issueIntent: "x", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 1 },
    },
    structured: true,
    decisions: null,
  }),
}));

vi.mock("../executor/session-store.js", async () => {
  const real = await vi.importActual<typeof import("../executor/session-store.js")>(
    "../executor/session-store.js",
  );
  return { ...real, transcriptExists: vi.fn().mockReturnValue(false) };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns, agentLogs } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-251",
  slug: "error-capture-repro",
  title: "Error capture reproduction",
  description: "Reproduce BEC-251",
  acceptanceCriteria: ["exitCode and stderr captured"],
  labels: ["auto-implement"],
  priority: 3,
};

const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

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

/** Create an error shaped like the SDK's getProcessExitError, with extra fields. */
function makeProcessExitError(exitCode: number, stderr: string): Error {
  const err = new Error(`Claude Code process exited with code ${exitCode}`);
  // The issue says these fields should be capturable; simulate what an enriched
  // SDK error or a future SDK version might expose (and what we want to capture).
  (err as any).exitCode = exitCode;
  (err as any).stderr = stderr;
  return err;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BEC-251 — executor error capture (reproduce)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
  });

  it("CONFIRMS BUG: agent_logs.content only contains the plain message — exitCode and stderr are discarded", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Simulate the SDK throwing a process-exit error with diagnostic fields
    const sdkError = makeProcessExitError(1, "auth: 401 Unauthorized");
    (query as any).mockImplementation(() => {
      throw sdkError;
    });

    const runId = "run-bec251-repro";
    await seedPipelineRun(db, runId);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: "session-uuid-1",
    });

    // Stage should fail
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("Claude Code process exited with code 1");

    // Fetch the error log entry
    const logs = await (db as any)
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.type, "error"));

    expect(logs).toHaveLength(1);
    const content = logs[0].content;

    // ── BUG CONFIRMATION ──────────────────────────────────────────────────────
    // The content is just the plain error message string.
    // exitCode, stderr, session info, auth method, and duration are NOT present.

    // Currently stored: plain message only
    expect(content).toBe("Claude Code process exited with code 1");

    // BUG: exitCode is NOT captured as a structured field
    expect(content).not.toContain('"exitCode"');
    expect(content).not.toContain('"exitCode":1');

    // BUG: stderr is NOT captured
    expect(content).not.toContain('"stderr"');
    expect(content).not.toContain("auth: 401");

    // BUG: session type (fresh vs resumed) is NOT captured
    expect(content).not.toContain('"sessionType"');
    expect(content).not.toContain('"fresh"');
    expect(content).not.toContain('"resumed"');

    // BUG: auth method is NOT captured
    expect(content).not.toContain('"authMethod"');
    expect(content).not.toContain('"api-key"');

    // BUG: duration is NOT captured
    expect(content).not.toContain('"durationMs"');
  });

  it("CONFIRMS BUG: error_message on StageResult is plain string with no structured context", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const sdkError = makeProcessExitError(1, "auth: 401 Unauthorized");
    (query as any).mockImplementation(() => {
      throw sdkError;
    });

    const runId = "run-bec251-stageresult";
    await seedPipelineRun(db, runId);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: null, // flag-off path (no session)
    });

    expect(result.status).toBe("failed");

    // The errorMessage propagated to the runner is just the plain SDK message.
    // An operator reading pipeline_runs.error_message sees only:
    //   "Claude Code process exited with code 1"
    // — with no indication of auth method, session state, or stderr.
    expect(result.errorMessage).toBe("Claude Code process exited with code 1");
    expect(result.errorMessage).not.toContain("exitCode");
    expect(result.errorMessage).not.toContain("stderr");
    expect(result.errorMessage).not.toContain("authMethod");
  });

  it("CONFIRMS BUG: resumed-session context is invisible when SDK throws — operator cannot distinguish fresh vs resume failure", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const sdkError = makeProcessExitError(1, "");
    (query as any).mockImplementation(() => {
      throw sdkError;
    });

    const runId = "run-bec251-session";
    await seedPipelineRun(db, runId);

    // Run with a session ID (resumed path)
    const resultResumed = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: "session-uuid-resume",
    });

    // Then run without (fresh path) — clear logs between
    const runId2 = "run-bec251-fresh";
    await seedPipelineRun(db, runId2);

    const resultFresh = await executeStage({
      runId: runId2,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec251-workdir",
      db,
      agentSessionId: null, // no session
    });

    // BUG: Both produce identical errorMessage — operator cannot tell which
    // session mode was active when the failure occurred.
    expect(resultResumed.errorMessage).toBe(resultFresh.errorMessage);
    expect(resultResumed.errorMessage).toBe("Claude Code process exited with code 1");
  });
});
