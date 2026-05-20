/**
 * BEC-227 / BEC-231 — deep-review SDK session shape.
 *
 * `runDeepReview` must derive the session call shape from on-disk state
 * (transcriptExists()), not from the in-memory `isFirstResumableStage` flag.
 * This matches the BEC-231 fix applied to executor.ts.
 *
 * When JSONL present  → `options.resume = agentSessionId`   (continue)
 * When JSONL absent   → `options.sessionId = agentSessionId` (create / retry)
 * When agentSessionId null → no session options
 *
 * The OpenRouter fanout providers are deliberately untouched — they have
 * no SDK session of their own to resume.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandoffArtifact } from "../types.js";

// SDK query mock — capture the options passed in.
const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

// Per-test transcriptExists control (hoisted so it's available before imports).
const { transcriptExistsMock } = vi.hoisted(() => ({
  transcriptExistsMock: vi.fn().mockReturnValue(false),
}));
vi.mock("../executor/session-store.js", async () => {
  const real = await vi.importActual<typeof import("../executor/session-store.js")>(
    "../executor/session-store.js",
  );
  return {
    ...real,
    transcriptExists: transcriptExistsMock,
  };
});

// Silence audit writer.
vi.mock("../audit/writer.js", async () => {
  const real = await vi.importActual<typeof import("../audit/writer.js")>(
    "../audit/writer.js",
  );
  return {
    ...real,
    logAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
});

import { runDeepReview } from "../executor/deep-review.js";

const makeHandoff = (): HandoffArtifact => ({
  runId: "r1",
  issueId: "i1",
  stage: "review",
  timestamp: new Date().toISOString(),
  summary: "summary",
  filesChanged: ["a.ts"],
  approach: "x",
  context: { issueIntent: "x", constraints: [], assumptions: [] },
  tokenBudget: { contextTokensUsed: 0, recommendedMaxTurns: 0 },
});

function makeMinimalStream() {
  return (async function* () {
    yield { type: "system" };
  })();
}

describe("deep-review session shape (BEC-227, BEC-231)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(() => makeMinimalStream());
    vi.clearAllMocks();
    queryMock.mockImplementation(() => makeMinimalStream());
  });

  it("JSONL present → passes resume: in options for all three sub-agents", async () => {
    // Transcript exists on disk → resume path.
    transcriptExistsMock.mockReturnValue(true);

    await runDeepReview({
      handoff: makeHandoff(),
      workdir: "/tmp/x",
      agentSessionId: "uuid-1",
      isFirstResumableStage: false,
      model: "claude-sonnet-4-6",
    });

    expect(queryMock).toHaveBeenCalled();
    for (const call of queryMock.mock.calls) {
      expect(call[0].options.resume).toBe("uuid-1");
      expect(call[0].options.sessionId).toBeUndefined();
    }
  });

  it("JSONL absent → passes sessionId: (create/retry), not empty opts (BEC-231)", async () => {
    // This is the BEC-231 bug scenario: the in-memory flag might say
    // "session initiated" but the JSONL was never written (e.g. auth 401
    // on the first deep-review attempt). The fix: absent JSONL → sessionId:
    // so the SDK gets a fresh shot at creating the transcript.
    transcriptExistsMock.mockReturnValue(false);

    await runDeepReview({
      handoff: makeHandoff(),
      workdir: "/tmp/x",
      agentSessionId: "uuid-2",
      isFirstResumableStage: false, // ignored since BEC-231 — transcriptExists drives shape
      model: "claude-sonnet-4-6",
    });

    expect(queryMock).toHaveBeenCalled();
    for (const call of queryMock.mock.calls) {
      expect(call[0].options.sessionId).toBe("uuid-2");
      expect(call[0].options.resume).toBeUndefined();
    }
  });

  it("agentSessionId null → no session options regardless of transcript state", async () => {
    transcriptExistsMock.mockReturnValue(true); // even if transcript exists, null id → no opts

    await runDeepReview({
      handoff: makeHandoff(),
      workdir: "/tmp/x",
      agentSessionId: null,
      model: "claude-sonnet-4-6",
    });

    expect(queryMock).toHaveBeenCalled();
    for (const call of queryMock.mock.calls) {
      expect(call[0].options.resume).toBeUndefined();
      expect(call[0].options.sessionId).toBeUndefined();
    }
  });
});
