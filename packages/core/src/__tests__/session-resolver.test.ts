/**
 * Tests for BEC-228 — `resolveSessionOpts` shared helper.
 *
 * Covers the five cases from the acceptance criteria:
 *  1. First-resumable stage → { sessionId }
 *  2. Non-first-resumable, transcript present → { resume } + resumed event
 *  3. Non-first-resumable, transcript missing → {} + fallback event
 *  4. Non-Claude model → {} with no events
 *  5. Always-fresh stage → {} with no events
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before imports) ────────────────────────────────────

// Control transcript existence and path resolution per test.
const transcriptExistsMock = vi.fn().mockReturnValue(true);
const transcriptPathMock = vi.fn().mockReturnValue("/fake/path/session.jsonl");
vi.mock("../executor/session-store.js", async () => {
  const real = await vi.importActual<typeof import("../executor/session-store.js")>(
    "../executor/session-store.js",
  );
  return {
    ...real,
    transcriptExists: transcriptExistsMock,
    transcriptPath: transcriptPathMock,
    defaultProjectsRoot: vi.fn().mockReturnValue("/fake/projects"),
  };
});

// Capture audit event writes.
const { logAuditEventMock } = vi.hoisted(() => ({
  logAuditEventMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../audit/writer.js", async () => {
  const real = await vi.importActual<typeof import("../audit/writer.js")>(
    "../audit/writer.js",
  );
  return { ...real, logAuditEvent: logAuditEventMock };
});

// Control readFileSync so we get a known priorMessageCount without a real file.
vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...real,
    readFileSync: vi.fn().mockReturnValue('{"type":"assistant"}\n{"type":"tool_result"}\n{"type":"text"}\n'),
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { resolveSessionOpts } from "../executor/session-resolver.js";
import { createDb } from "../db/client.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveSessionOpts (BEC-228)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
    logAuditEventMock.mockResolvedValue(undefined);
    transcriptExistsMock.mockReturnValue(true);
    transcriptPathMock.mockReturnValue("/fake/path/session.jsonl");
  });

  // AC #1 — first resumable stage returns { sessionId }, no transcript check.
  it("first-resumable stage returns {sessionId} and emits no audit events", async () => {
    const result = await resolveSessionOpts({
      stage: "implement",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-1",
      isFirstResumableStage: true,
      workdir: "/tmp/work",
      runId: "run-1",
      issueId: "issue-1",
      db: db as any,
    });

    expect(result).toEqual({ sessionId: "uuid-1" });
    expect(logAuditEventMock).not.toHaveBeenCalled();
    // transcriptExists must NOT be called — no disk check on first stage.
    expect(transcriptExistsMock).not.toHaveBeenCalled();
  });

  // AC #2 — non-first resumable with transcript present → { resume } + resumed event.
  it("non-first-resumable with transcript present returns {resume} and emits resumed event", async () => {
    transcriptExistsMock.mockReturnValue(true);

    const result = await resolveSessionOpts({
      stage: "implement",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-2",
      isFirstResumableStage: false,
      workdir: "/tmp/work",
      runId: "run-2",
      issueId: "issue-2",
      db: db as any,
    });

    expect(result).toEqual({ resume: "uuid-2" });

    // One audit event — pipeline.agent_session_resumed.
    expect(logAuditEventMock).toHaveBeenCalledOnce();
    const [, event] = logAuditEventMock.mock.calls[0];
    expect(event.eventType).toBe("pipeline.agent_session_resumed");
    expect(event.payload.sessionId).toBe("uuid-2");
    expect(event.payload.runId).toBe("run-2");
    expect(event.payload.issueId).toBe("issue-2");
    expect(event.payload.stage).toBe("implement");
    // priorMessageCount from our 3-line mock readFileSync.
    expect(event.payload.priorMessageCount).toBe(3);
  });

  // AC #3 — non-first resumable with transcript missing → {} + fallback event.
  it("non-first-resumable with missing transcript returns {} and emits fallback event", async () => {
    transcriptExistsMock.mockReturnValue(false);

    const result = await resolveSessionOpts({
      stage: "review",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-3",
      isFirstResumableStage: false,
      workdir: "/tmp/work",
      runId: "run-3",
      issueId: "issue-3",
      db: db as any,
    });

    expect(result).toEqual({});

    expect(logAuditEventMock).toHaveBeenCalledOnce();
    const [, event] = logAuditEventMock.mock.calls[0];
    expect(event.eventType).toBe("pipeline.agent_session_missing_fallback");
    expect(event.payload.sessionId).toBe("uuid-3");
    expect(event.payload.reason).toBe("jsonl-not-found");
    expect(event.payload.runId).toBe("run-3");
    expect(event.payload.issueId).toBe("issue-3");
  });

  // AC #4 — non-Claude model returns {} with no events.
  it("non-Claude model (OpenRouter) returns {} with no events", async () => {
    const result = await resolveSessionOpts({
      stage: "implement",
      model: "qwen/qwen2.5-72b-instruct",
      agentSessionId: "uuid-4",
      isFirstResumableStage: false,
      workdir: "/tmp/work",
      runId: "run-4",
      issueId: "issue-4",
      db: db as any,
    });

    expect(result).toEqual({});
    expect(logAuditEventMock).not.toHaveBeenCalled();
    expect(transcriptExistsMock).not.toHaveBeenCalled();
  });

  // AC #5 — always-fresh stage returns {} with no events.
  it("always-fresh stage (validate) returns {} with no events", async () => {
    const result = await resolveSessionOpts({
      stage: "validate",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-5",
      isFirstResumableStage: false,
      workdir: "/tmp/work",
      runId: "run-5",
      issueId: "issue-5",
      db: db as any,
    });

    expect(result).toEqual({});
    expect(logAuditEventMock).not.toHaveBeenCalled();
    expect(transcriptExistsMock).not.toHaveBeenCalled();
  });

  // Bonus: agentSessionId null → {} with no events (flag off path).
  it("agentSessionId null returns {} with no events", async () => {
    const result = await resolveSessionOpts({
      stage: "implement",
      model: "claude-sonnet-4-6",
      agentSessionId: null,
      isFirstResumableStage: false,
      workdir: "/tmp/work",
    });

    expect(result).toEqual({});
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  // Bonus: deep-review qualified stage label ("review:reuse") works correctly.
  it("qualified deep-review stage label passes policy and returns {resume}", async () => {
    transcriptExistsMock.mockReturnValue(true);

    const result = await resolveSessionOpts({
      stage: "review:reuse",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-6",
      isFirstResumableStage: false,
      workdir: "/tmp/work",
      runId: "run-6",
      issueId: "issue-6",
      db: db as any,
    });

    expect(result).toEqual({ resume: "uuid-6" });
    const [, event] = logAuditEventMock.mock.calls[0];
    expect(event.eventType).toBe("pipeline.agent_session_resumed");
    expect(event.payload.stage).toBe("review:reuse");
  });
});
