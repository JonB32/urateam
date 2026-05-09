/**
 * BEC-183 reproduction: pre-stream stall — query() hangs before first message;
 * watchdog doesn't apply.
 *
 * This file documents and exercises the CURRENT (buggy) behaviour to confirm
 * the feature gap before the fix is applied.  Run with:
 *
 *   cd packages/core && npx vitest run src/__tests__/bec-183-pre-stream-stall.test.ts
 *
 * All assertions below are written to PASS against the current (unfixed) code,
 * demonstrating the three concrete gaps that BEC-183 must close.
 */
import { describe, it, expect } from "vitest";
import * as agentStreamModule from "../executor/agent-stream.js";
import { consumeAgentStream, StageStalledError } from "../executor/agent-stream.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulates the SDK's query() returning an iterator that hangs before the
 *  very first message — e.g., blocked inside an auth-retry loop. */
async function* neverYields(): AsyncIterable<unknown> {
  // The generator is entered but immediately suspends forever, producing
  // zero messages.  This is the trigger scenario from the BEC-183 dogfood log.
  await new Promise<never>(() => {});
}

/** Yields one real assistant message, then hangs — the existing mid-stream
 *  stall pattern already covered by StageStalledError. */
async function* hangsAfterOne(): AsyncIterable<unknown> {
  yield {
    type: "assistant",
    usage: { output_tokens: 10 },
    content: [{ type: "text", text: "one message then hang" }],
  };
  await new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// Gap 1 — StagePreStreamStalledError class is missing
// ---------------------------------------------------------------------------
describe("BEC-183 gap 1 — StagePreStreamStalledError class is missing", () => {
  it("StagePreStreamStalledError is NOT exported from agent-stream.ts", () => {
    // @ts-expect-error — the class does not exist yet; this is the missing piece
    const cls = (agentStreamModule as Record<string, unknown>)["StagePreStreamStalledError"];
    expect(cls).toBeUndefined();
    // ---- expected after fix: cls should be a non-undefined constructor ----
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — consumeAgentStream has no firstMessageTimeoutMs parameter;
//          a never-yielding iterator is only protected by the blunt
//          progressTimeoutMs watchdog (defaults to 30 minutes in production).
// ---------------------------------------------------------------------------
describe("BEC-183 gap 2 — no firstMessageTimeoutMs; falls through to progressTimeoutMs", () => {
  it(
    "neverYields iterator throws StageStalledError after progressTimeoutMs, not a dedicated pre-stream error",
    async () => {
      // Use 150 ms so the test finishes quickly.  In production executor.ts
      // passes NO progressTimeoutMs, so the default is 30 * 60_000 ms = 30 min.
      // A 5-min firstMessageTimeoutMs would catch it 6× faster.
      const start = Date.now();

      const err = await consumeAgentStream(neverYields(), {
        progressTimeoutMs: 150,
        // firstMessageTimeoutMs is not a recognised option yet — it will be silently ignored
        // @ts-expect-error
        firstMessageTimeoutMs: 50, // even if passed, has no effect
      }).catch((e: unknown) => e);

      const elapsed = Date.now() - start;

      // The error that fires is StageStalledError (the mid-stream watchdog),
      // NOT a StagePreStreamStalledError (which doesn't exist yet).
      expect(err).toBeInstanceOf(StageStalledError);
      expect(err).not.toBeInstanceOf(
        // @ts-expect-error — class does not exist yet
        (agentStreamModule as Record<string, unknown>)["StagePreStreamStalledError"] ?? class {},
      );

      // Fires around progressTimeoutMs (150 ms), NOT after the shorter
      // firstMessageTimeoutMs (50 ms) — because firstMessageTimeoutMs doesn't exist.
      expect(elapsed).toBeGreaterThanOrEqual(140); // respects progressTimeoutMs
    },
    3_000, // generous wall-clock budget for the test
  );

  it("mid-stream stall (after ≥1 message) still throws StageStalledError — regression guard", async () => {
    // This existing behaviour must NOT be broken by the fix.
    await expect(
      consumeAgentStream(hangsAfterOne(), { progressTimeoutMs: 150 }),
    ).rejects.toBeInstanceOf(StageStalledError);
  });
});

// ---------------------------------------------------------------------------
// Gap 3 — executor.ts has no wall-clock stage timeout
//          (static analysis check — we inspect the source text)
// ---------------------------------------------------------------------------
describe("BEC-183 gap 3 — executor.ts has no wall-clock stage timeout", () => {
  it("executeStage source contains no Promise.race / AbortSignal.timeout against a wall-clock cap", async () => {
    // Dynamic import of the raw source text to verify absence of wall-clock guard.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const executorSrc = fs.readFileSync(
      path.resolve(__dirname, "../executor/executor.ts"),
      "utf8",
    );

    // These identifiers/patterns would be present after the fix:
    const hasWallClockTimeout =
      /WALL_CLOCK_STAGE_TIMEOUT/i.test(executorSrc) ||
      /stageTimeoutMs/i.test(executorSrc) ||
      /AbortSignal\.timeout/i.test(executorSrc);

    expect(hasWallClockTimeout).toBe(false);
    // ---- expected after fix: one of those patterns should be present ----
  });

  it("consumeAgentStream call in executor.ts passes no firstMessageTimeoutMs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const executorSrc = fs.readFileSync(
      path.resolve(__dirname, "../executor/executor.ts"),
      "utf8",
    );

    expect(executorSrc).not.toContain("firstMessageTimeoutMs");
    // ---- expected after fix: executor.ts should pass firstMessageTimeoutMs ----
  });
});
