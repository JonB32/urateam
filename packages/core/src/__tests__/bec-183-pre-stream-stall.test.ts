/**
 * BEC-183: pre-stream stall — verify the fix.
 *
 * Tests verify:
 *  1. StagePreStreamStalledError is exported from agent-stream.ts
 *  2. consumeAgentStream throws it when no message arrives within firstMessageTimeoutMs
 *  3. Mid-stream stall (after ≥1 message) still throws StageStalledError (regression guard)
 *  4. executor.ts source contains wall-clock stage timeout (WALL_CLOCK_STAGE_TIMEOUT_MS)
 *     and passes firstMessageTimeoutMs to consumeAgentStream
 *
 * Run with:
 *   cd packages/core && npx vitest run src/__tests__/bec-183-pre-stream-stall.test.ts
 */
import { describe, it, expect } from "vitest";
import * as agentStreamModule from "../executor/agent-stream.js";
import {
  consumeAgentStream,
  StageStalledError,
  StagePreStreamStalledError,
} from "../executor/agent-stream.js";

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
// Fix 1 — StagePreStreamStalledError class is exported
// ---------------------------------------------------------------------------
describe("BEC-183 fix 1 — StagePreStreamStalledError class is exported", () => {
  it("StagePreStreamStalledError is exported from agent-stream.ts", () => {
    const cls = (agentStreamModule as Record<string, unknown>)["StagePreStreamStalledError"];
    expect(cls).toBeDefined();
    expect(typeof cls).toBe("function");
  });

  it("StagePreStreamStalledError is a distinct class from StageStalledError", () => {
    const preStream = new StagePreStreamStalledError(5000);
    expect(preStream).toBeInstanceOf(StagePreStreamStalledError);
    expect(preStream).not.toBeInstanceOf(StageStalledError);
    expect(preStream.name).toBe("StagePreStreamStalledError");
    expect(preStream.timeoutMs).toBe(5000);
    expect(preStream.message).toContain("pre-stream stall");
    expect(preStream.message).toContain("5s");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — consumeAgentStream throws StagePreStreamStalledError when iterator
//          never yields its first message within firstMessageTimeoutMs
// ---------------------------------------------------------------------------
describe("BEC-183 fix 2 — firstMessageTimeoutMs fires StagePreStreamStalledError", () => {
  it(
    "neverYields iterator throws StagePreStreamStalledError after firstMessageTimeoutMs (not StageStalledError)",
    async () => {
      const err = await consumeAgentStream(neverYields(), {
        firstMessageTimeoutMs: 150, // short for test speed
        progressTimeoutMs: 5_000,   // large; must not fire first
      }).catch((e: unknown) => e);

      // Must be StagePreStreamStalledError, not the mid-stream StageStalledError
      expect(err).toBeInstanceOf(StagePreStreamStalledError);
      expect(err).not.toBeInstanceOf(StageStalledError);
      const preStream = err as StagePreStreamStalledError;
      expect(preStream.timeoutMs).toBe(150);
    },
    3_000,
  );

  it(
    "when firstMessageTimeoutMs fires first, StagePreStreamStalledError is thrown; StageStalledError fires only after first message arrives",
    async () => {
      // firstMessageTimeoutMs (100ms) fires before progressTimeoutMs (1000ms)
      // and no first message has arrived → StagePreStreamStalledError
      const errPreStream = await consumeAgentStream(neverYields(), {
        firstMessageTimeoutMs: 100,
        progressTimeoutMs: 1_000,
      }).catch((e: unknown) => e);
      expect(errPreStream).toBeInstanceOf(StagePreStreamStalledError);

      // A first message arrives immediately; then hangs.
      // firstMessageTimeoutMs (1000ms) does NOT fire because firstMessageReceived=true.
      // progressTimeoutMs (100ms) fires after mid-stream silence → StageStalledError.
      const errStalled = await consumeAgentStream(hangsAfterOne(), {
        firstMessageTimeoutMs: 1_000,
        progressTimeoutMs: 100,
      }).catch((e: unknown) => e);
      expect(errStalled).toBeInstanceOf(StageStalledError);
    },
    5_000,
  );
});

// ---------------------------------------------------------------------------
// Fix 3 — mid-stream stall still throws StageStalledError (regression guard)
// ---------------------------------------------------------------------------
describe("BEC-183 fix 3 — mid-stream stall regression guard", () => {
  it(
    "iterator that yields once then hangs throws StageStalledError, not StagePreStreamStalledError",
    async () => {
      const err = await consumeAgentStream(hangsAfterOne(), {
        firstMessageTimeoutMs: 5_000, // large; must not fire (first message arrives quickly)
        progressTimeoutMs: 150,       // short; fires after mid-stream hang
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(StageStalledError);
      expect(err).not.toBeInstanceOf(StagePreStreamStalledError);
    },
    3_000,
  );
});

// ---------------------------------------------------------------------------
// Fix 4 — executor.ts has wall-clock stage timeout
//          (static analysis check — we inspect the source text)
// ---------------------------------------------------------------------------
describe("BEC-183 fix 4 — executor.ts wall-clock stage timeout", () => {
  it("executeStage source contains WALL_CLOCK_STAGE_TIMEOUT_MS constant", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const executorSrc = fs.readFileSync(
      path.resolve(__dirname, "../executor/executor.ts"),
      "utf8",
    );

    expect(executorSrc).toContain("WALL_CLOCK_STAGE_TIMEOUT_MS");
    expect(executorSrc).toContain("stageTimeoutMs");
  });

  it("consumeAgentStream call in executor.ts passes firstMessageTimeoutMs", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const executorSrc = fs.readFileSync(
      path.resolve(__dirname, "../executor/executor.ts"),
      "utf8",
    );

    expect(executorSrc).toContain("firstMessageTimeoutMs");
  });

  it("executor.ts default stage timeout is 30 min and implement is 60 min", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");

    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const executorSrc = fs.readFileSync(
      path.resolve(__dirname, "../executor/executor.ts"),
      "utf8",
    );

    // 60 min for implement
    expect(executorSrc).toContain("60 * 60_000");
    // 30 min default
    expect(executorSrc).toContain("30 * 60_000");
    // implement key explicitly named
    expect(executorSrc).toContain("implement");
  });
});
