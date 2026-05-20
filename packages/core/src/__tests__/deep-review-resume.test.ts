/**
 * BEC-227 — Task 11: deep-review SDK call session resume.
 *
 * `runDeepReview` should pass `options.resume = agentSessionId` to the
 * Claude Agent SDK when:
 *   - `agentSessionId` is non-null
 *   - `isFirstResumableStage === false`
 *   - the resolved model is in the resumable family (sonnet/opus)
 *   - the transcript JSONL exists on disk
 *
 * Otherwise (null sessionId, fresh stage, non-resumable model, missing
 * transcript) `options.resume` must be undefined.
 *
 * The OpenRouter fanout providers are deliberately untouched — they have
 * no SDK session of their own to resume.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HandoffArtifact } from "../types.js";

// SDK query mock — capture the options passed in.
const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

// Force resolveTranscript → exists:true so the resume branch fires without
// needing real filesystem state. This matches the Task-7 pattern in
// session-resume-fallback.test.ts.
vi.mock("../executor/session-store.js", async () => {
  const real = await vi.importActual<typeof import("../executor/session-store.js")>(
    "../executor/session-store.js",
  );
  return {
    ...real,
    resolveTranscript: vi.fn().mockReturnValue({ path: "/fake/session.jsonl", exists: true }),
  };
});

// Silence audit writer — Task 11 doesn't assert audit events.
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

describe("deep-review resume (BEC-227, Task 11)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(() => makeMinimalStream());
  });

  it("agentSessionId provided + resumable model + not-first → passes resume in options", async () => {
    await runDeepReview({
      handoff: makeHandoff(),
      workdir: "/tmp/x",
      agentSessionId: "uuid-1",
      isFirstResumableStage: false,
      model: "claude-sonnet-4-6",
    });

    expect(queryMock).toHaveBeenCalled();
    // 3 parallel sub-agents — each call should carry the same resume opt.
    for (const call of queryMock.mock.calls) {
      expect(call[0].options.resume).toBe("uuid-1");
      expect(call[0].options.sessionId).toBeUndefined();
    }
  });

  it("agentSessionId null → no resume in options", async () => {
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
