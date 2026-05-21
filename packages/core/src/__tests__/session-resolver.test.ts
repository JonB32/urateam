/**
 * Tests for BEC-228 — `resolveSessionOpts` shared helper.
 *
 * The helper combines BEC-227 (per-run SDK session resume) with BEC-231
 * (derive shape from on-disk state, not in-memory flag). The shape is:
 *  1. Transcript on disk → { resume: <uuid> } + emit resumed event
 *  2. Transcript absent  → { sessionId: <uuid> } (create or re-create; no event)
 *  3. Non-Claude model   → {}
 *  4. Always-fresh stage → {}
 *  5. agentSessionId null (flag off) → {}
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks (declared before imports) ────────────────────────────────────

// Control transcript existence and path resolution per test. Hoisted because
// vi.mock factory bodies run before top-level declarations would normally exist.
const { transcriptExistsMock, transcriptPathMock } = vi.hoisted(() => ({
  transcriptExistsMock: vi.fn().mockReturnValue(true),
  transcriptPathMock: vi.fn().mockReturnValue("/fake/path/session.jsonl"),
}));
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

// ── Imports ───────────────────────────────────────────────────────────────────

import { resolveSessionOpts } from "../executor/session-resolver.js";
import { createDb } from "../db/client.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveSessionOpts (BEC-228 + BEC-231)", () => {
  let db: Awaited<ReturnType<typeof createDb>>;

  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
    vi.clearAllMocks();
    logAuditEventMock.mockResolvedValue(undefined);
    transcriptExistsMock.mockReturnValue(true);
    transcriptPathMock.mockReturnValue("/fake/path/session.jsonl");
  });

  // Case 1 — transcript present → { resume } + resumed event
  it("transcript present returns {resume} and emits resumed event", async () => {
    transcriptExistsMock.mockReturnValue(true);

    const result = await resolveSessionOpts({
      stage: "implement",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-2",
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
    // priorMessageCount falls back to 0 when the path doesn't exist on disk
    // (countLines fails — caught and logged); the event still fires.
    expect(event.payload.priorMessageCount).toBe(0);
  });

  // Case 2 — transcript absent → { sessionId } and NO events (BEC-231)
  it("transcript absent returns {sessionId} with no events (BEC-231: create/re-create path)", async () => {
    transcriptExistsMock.mockReturnValue(false);

    const result = await resolveSessionOpts({
      stage: "review",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-3",
      workdir: "/tmp/work",
      runId: "run-3",
      issueId: "issue-3",
      db: db as any,
    });

    expect(result).toEqual({ sessionId: "uuid-3" });
    // BEC-231: no missing-fallback event — the helper now handles transcript
    // absence as a (re-)create rather than a fallback. The SDK will write a
    // fresh JSONL when the first message lands.
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  // Case 3 — non-Claude model returns {} with no events
  it("non-Claude model (OpenRouter) returns {} with no events", async () => {
    const result = await resolveSessionOpts({
      stage: "implement",
      model: "qwen/qwen2.5-72b-instruct",
      agentSessionId: "uuid-4",
      workdir: "/tmp/work",
      runId: "run-4",
      issueId: "issue-4",
      db: db as any,
    });

    expect(result).toEqual({});
    expect(logAuditEventMock).not.toHaveBeenCalled();
    expect(transcriptExistsMock).not.toHaveBeenCalled();
  });

  // Case 4 — always-fresh stage returns {} with no events
  it("always-fresh stage (validate) returns {} with no events", async () => {
    const result = await resolveSessionOpts({
      stage: "validate",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-5",
      workdir: "/tmp/work",
      runId: "run-5",
      issueId: "issue-5",
      db: db as any,
    });

    expect(result).toEqual({});
    expect(logAuditEventMock).not.toHaveBeenCalled();
    expect(transcriptExistsMock).not.toHaveBeenCalled();
  });

  // Case 5 — agentSessionId null (flag off) → {}
  it("agentSessionId null returns {} with no events", async () => {
    const result = await resolveSessionOpts({
      stage: "implement",
      model: "claude-sonnet-4-6",
      agentSessionId: null,
      workdir: "/tmp/work",
    });

    expect(result).toEqual({});
    expect(logAuditEventMock).not.toHaveBeenCalled();
  });

  // Case 6 — deep-review qualified stage label works
  it("qualified deep-review stage label passes policy and returns {resume}", async () => {
    transcriptExistsMock.mockReturnValue(true);

    const result = await resolveSessionOpts({
      stage: "review:reuse",
      model: "claude-sonnet-4-6",
      agentSessionId: "uuid-6",
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
