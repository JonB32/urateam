/**
 * Tests for BEC-227 — Task 7:
 * JSONL-exists pre-check on the resume path of `executeStage()`.
 *
 * Scenario covered:
 *  - When `agentSessionId` is set and `isFirstResumableStage=false` BUT the
 *    SDK transcript JSONL file does NOT exist on disk for the (cwd, sessionId)
 *    tuple, the executor must:
 *      1. Drop the resume option (call shape is fresh: no `sessionId`, no `resume`)
 *      2. Emit the `pipeline.agent_session_missing_fallback` audit event with
 *         `reason: "jsonl-not-found"`
 *      3. Log a warning
 *
 * The SDK `query` and `logAuditEvent` are mocked, and `transcriptExists` is
 * forced to return `false` so this test does not depend on the host filesystem.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before imports) ────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  resolveClaudeAuth: vi.fn().mockReturnValue({ method: "session" }),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "run-bec227-t7",
      issueId: "BEC-227",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Stub handoff",
      filesChanged: [],
      approach: "Stub",
      context: { issueIntent: "x", constraints: [], assumptions: [] },
      tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 1 },
    },
    structured: true,
  }),
}));

vi.mock("../executor/session-store.js", async () => {
  const real = await vi.importActual<typeof import("../executor/session-store.js")>(
    "../executor/session-store.js",
  );
  return {
    ...real,
    // Force the transcript-not-found path so the fallback branch fires.
    transcriptExists: vi.fn().mockReturnValue(false),
  };
});

const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../audit/writer.js", async () => {
  const real = await vi.importActual<typeof import("../audit/writer.js")>(
    "../audit/writer.js",
  );
  return {
    ...real,
    logAuditEvent: logAuditEventMock,
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { executeStage } from "../executor/executor.js";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-227",
  slug: "agent-session-continuity",
  title: "Agent session continuity Phase 1",
  description: "Resume fallback when JSONL is missing",
  acceptanceCriteria: ["fallback to fresh session on missing JSONL"],
  labels: ["auto-implement"],
  priority: 4,
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

function makeMinimalStream() {
  return (async function* () {
    yield {
      type: "assistant",
      content: [{ type: "text", text: "done" }],
    };
  })();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeStage — session resume fallback (BEC-227, Task 7)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
    logAuditEventMock.mockClear();
    logAuditEventMock.mockResolvedValue(undefined);
  });

  it("transcript missing → falls back to fresh session and emits missing_fallback audit event", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-fallback-t7");

    await executeStage({
      runId: "run-fallback-t7",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/nonexistent/path/bec227-t7",
      db,
      agentSessionId: "uuid-nonexistent",
      isFirstResumableStage: false,
    });

    // SDK call shape: no resume, no sessionId (fresh)
    expect(query).toHaveBeenCalledOnce();
    const opts = (query as any).mock.calls[0][0].options;
    expect(opts.resume).toBeUndefined();
    expect(opts.sessionId).toBeUndefined();

    // Audit event emitted with jsonl-not-found reason
    const fallbackCall = logAuditEventMock.mock.calls.find(
      (call: any[]) => call[1]?.eventType === "pipeline.agent_session_missing_fallback",
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall![1].payload.reason).toBe("jsonl-not-found");
    expect(fallbackCall![1].payload.sessionId).toBe("uuid-nonexistent");
    expect(fallbackCall![1].payload.runId).toBe("run-fallback-t7");
    expect(fallbackCall![1].payload.issueId).toBe(testIssue.id);
  });
});
