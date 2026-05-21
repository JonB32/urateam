/**
 * Tests for BEC-227 Task 7, AS UPDATED BY BEC-231 (lazy session creation).
 *
 * Original BEC-227 design (T7): when `isFirstResumableStage=false` AND the
 * JSONL is missing, drop to fresh-session shape (no opts) + emit
 * `missing_fallback` audit event. The bug: the in-memory `hasInitiatedSession`
 * flag flipped after the first stage's CALL, not after the SDK actually wrote
 * the JSONL. If the first stage failed (auth 401, etc.) before writing, every
 * later stage thought "session initiated; use resume:" but the JSONL didn't
 * exist, so they all dropped to fresh-session-with-no-opts — losing the
 * session permanently for the run's lifetime.
 *
 * BEC-231 fix: derive the shape from on-disk state, not from the in-memory
 * flag. JSONL present → `resume:`. JSONL absent → `sessionId:` (retries
 * creation). The `missing_fallback` audit event is no longer emitted from
 * the executor — the new logic always picks the right shape.
 *
 * This test now verifies the new behavior: missing JSONL → SDK call shape
 * is `{ sessionId: <uuid> }` (the create/retry path), NOT empty opts.
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

describe("executeStage — lazy session creation when JSONL absent (BEC-231 update of BEC-227 T7)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
    logAuditEventMock.mockClear();
    logAuditEventMock.mockResolvedValue(undefined);
  });

  it("transcript missing → retries session creation (sessionId set), does NOT emit missing_fallback (BEC-231)", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    await seedPipelineRun(db, "run-bec231-retry-create");

    // Even though the caller passes isFirstResumableStage=false (the old
    // pre-BEC-231 callers do this for non-first stages), the new logic checks
    // transcriptExists() and routes to sessionId: when it returns false.
    await executeStage({
      runId: "run-bec231-retry-create",
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/nonexistent/path/bec231",
      db,
      agentSessionId: "uuid-bec231-recreate",
      isFirstResumableStage: false, // ← ignored under BEC-231
    });

    expect(query).toHaveBeenCalledOnce();
    const opts = (query as any).mock.calls[0][0].options;
    // BEC-231: when JSONL is absent, we (re-)create with sessionId: rather
    // than dropping to legacy fresh-session shape.
    expect(opts.sessionId).toBe("uuid-bec231-recreate");
    expect(opts.resume).toBeUndefined();

    // BEC-231: missing_fallback audit event is no longer emitted from the
    // executor — the new logic always picks the right shape.
    const fallbackCall = logAuditEventMock.mock.calls.find(
      (call: any[]) => call[1]?.eventType === "pipeline.agent_session_missing_fallback",
    );
    expect(fallbackCall).toBeUndefined();

    // resumed event is also not emitted (we're creating, not resuming).
    const resumedCall = logAuditEventMock.mock.calls.find(
      (call: any[]) => call[1]?.eventType === "pipeline.agent_session_resumed",
    );
    expect(resumedCall).toBeUndefined();
  });
});
