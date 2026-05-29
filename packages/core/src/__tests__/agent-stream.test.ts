import { describe, it, expect } from "vitest";
import { parseJsonObject } from "../executor/agent-stream.js";
import {
  consumeAgentStream,
  StageStalledError,
  StageCancelledError,
} from "../executor/agent-stream.js";

async function* fromArray(items: Array<unknown>): AsyncIterable<unknown> {
  for (const item of items) yield item;
}

/** Async iterable that yields the given items, then sleeps forever. */
async function* hangsAfter(items: Array<unknown>): AsyncIterable<unknown> {
  for (const item of items) yield item;
  await new Promise(() => {}); // never resolves
}

/** Async iterable where each yield is delayed by `delayMs` and emits an output_tokens bump. */
async function* tokenStream(count: number, delayMs: number): AsyncIterable<unknown> {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield { type: "assistant", usage: { output_tokens: 5 }, content: [{ type: "text", text: `chunk ${i}` }] };
  }
}

describe("consumeAgentStream — basic behavior", () => {
  it("accumulates token usage across messages", async () => {
    const result = await consumeAgentStream(
      fromArray([
        { usage: { input_tokens: 100, output_tokens: 50 } },
        { usage: { input_tokens: 20, output_tokens: 30 } },
      ]),
    );
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(80);
  });

  it("accumulates token usage from nested message.message.usage (assistant shape)", async () => {
    // The Agent SDK wraps per-turn usage inside `message.message.usage` on
    // assistant messages — only the final `result` message carries top-level
    // `usage`. Max-turns failures throw before that result message, so without
    // reading the nested path tokens record as 0.
    const result = await consumeAgentStream(
      fromArray([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "turn 1" }],
            usage: { input_tokens: 200, output_tokens: 75, cache_read_input_tokens: 1000 },
          },
        },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "turn 2" }],
            usage: { input_tokens: 50, output_tokens: 25 },
          },
        },
      ]),
    );
    expect(result.inputTokens).toBe(250);
    expect(result.outputTokens).toBe(100);
    expect(result.cacheReadInputTokens).toBe(1000);
    expect(result.turns).toBe(2);
  });

  it("prefers top-level usage when present, falls back to nested", async () => {
    const result = await consumeAgentStream(
      fromArray([
        // top-level wins
        {
          type: "result",
          usage: { input_tokens: 1, output_tokens: 1 },
          message: { usage: { input_tokens: 999, output_tokens: 999 } },
        },
        // top-level absent → nested is used
        {
          type: "assistant",
          message: { content: "x", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]),
    );
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(6);
  });

  it("counts assistant messages as turns and extracts last text", async () => {
    const result = await consumeAgentStream(
      fromArray([
        { type: "assistant", content: [{ type: "text", text: "first" }] },
        { type: "assistant", content: [{ type: "text", text: "last" }] },
      ]),
    );
    expect(result.turns).toBe(2);
    expect(result.lastText).toBe("last");
  });
});

describe("consumeAgentStream — stall watchdog (urateam#122)", () => {
  it("throws StageStalledError when the iterator hangs longer than progressTimeoutMs", async () => {
    await expect(
      consumeAgentStream(hangsAfter([{ type: "assistant", content: [{ type: "text", text: "ok" }] }]), {
        progressTimeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(StageStalledError);
  });

  it("includes last observed stats in the StageStalledError", async () => {
    try {
      await consumeAgentStream(
        hangsAfter([
          { type: "assistant", usage: { output_tokens: 12 }, content: [{ type: "text", text: "hi" }] },
        ]),
        { progressTimeoutMs: 200 },
      );
      throw new Error("expected StageStalledError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageStalledError);
      const stalled = err as StageStalledError;
      expect(stalled.lastStats.turns).toBe(1);
      expect(stalled.lastStats.outputTokens).toBe(12);
      // Node timers can fire 1–2ms early under CI load; loosen the lower bound
      // so the assertion still proves the watchdog stalled "around" 200ms
      // without flaking on Node's setTimeout jitter. (Saw 199ms on GitHub
      // Actions; PR #135 unrelated CI block.)
      expect(stalled.stalledForMs).toBeGreaterThanOrEqual(180);
    }
  });

  it("does NOT fire when output tokens keep advancing within the window", async () => {
    // 4 chunks at 30ms each = 120ms total. Window is 250ms but resets on each token bump.
    // Generous slack (130ms+) keeps this from flaking under loaded CI.
    const result = await consumeAgentStream(tokenStream(4, 30), { progressTimeoutMs: 250 });
    expect(result.turns).toBe(4);
    expect(result.outputTokens).toBe(20);
  });

  it("fires when messages keep arriving but no output tokens / turns advance", async () => {
    // Reproduction of the ROT-15 zombie pattern: messageCount advances slowly, but
    // turns and outputTokens stay flat. Watchdog must catch this.
    async function* zombieStream(): AsyncIterable<unknown> {
      // First a real assistant message to seed lastTokenAdvanceAt.
      yield { type: "assistant", usage: { output_tokens: 5 }, content: [{ type: "text", text: "start" }] };
      // Then a slow drip of non-progress messages (system events with no tokens, no turns).
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield { type: "system" };
      }
    }
    await expect(
      consumeAgentStream(zombieStream(), { progressTimeoutMs: 200 }),
    ).rejects.toBeInstanceOf(StageStalledError);
  });
});

describe("consumeAgentStream — operator abort", () => {
  it("throws StageCancelledError when the AbortController fires mid-stream", async () => {
    const controller = new AbortController();
    // Stream that emits one message, then waits forever. The abort below fires
    // while the second .next() is pending so we hit the abort branch of the
    // race instead of the stall branch.
    async function* slow(): AsyncIterable<unknown> {
      yield { type: "assistant", content: [{ type: "text", text: "first" }], usage: { output_tokens: 5 } };
      await new Promise(() => {});
    }
    setTimeout(() => controller.abort(), 50);
    await expect(
      consumeAgentStream(slow(), {
        abortSignal: controller.signal,
        progressTimeoutMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(StageCancelledError);
  });

  it("throws StageCancelledError immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    async function* never(): AsyncIterable<unknown> {
      await new Promise(() => {});
    }
    await expect(
      consumeAgentStream(never(), { abortSignal: controller.signal }),
    ).rejects.toBeInstanceOf(StageCancelledError);
  });

  it("ignores the abort signal once the stream completes normally", async () => {
    const controller = new AbortController();
    async function* fast(): AsyncIterable<unknown> {
      yield { type: "assistant", content: [{ type: "text", text: "done" }], usage: { output_tokens: 5 } };
    }
    const result = await consumeAgentStream(fast(), { abortSignal: controller.signal });
    controller.abort(); // post-hoc, should not throw or matter
    expect(result.lastText).toBe("done");
  });
});

describe("parseJsonObject — nested-JSON handling (triage v2 regression)", () => {
  it("parses a flat object", () => {
    expect(parseJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("parses a nested object (riskAssessment shape)", () => {
    const text = '{"priority":2,"riskAssessment":{"severity":"low","areas":["api"]}}';
    expect(parseJsonObject(text)).toEqual({
      priority: 2,
      riskAssessment: { severity: "low", areas: ["api"] },
    });
  });

  it("parses an object with array-of-objects (examples shape)", () => {
    const text = '{"examples":[{"scenario":"a","expected":"b"},{"scenario":"c","expected":"d"}]}';
    expect(parseJsonObject(text)).toEqual({
      examples: [
        { scenario: "a", expected: "b" },
        { scenario: "c", expected: "d" },
      ],
    });
  });

  it("extracts a JSON object surrounded by prose", () => {
    const text = 'Here is the result: {"a":1,"nested":{"b":2}} done.';
    expect(parseJsonObject(text)).toEqual({ a: 1, nested: { b: 2 } });
  });

  it("handles strings containing braces (string-aware brace counting)", () => {
    const text = '{"msg":"this has } a brace","ok":true}';
    expect(parseJsonObject(text)).toEqual({ msg: "this has } a brace", ok: true });
  });

  it("handles escaped quotes inside strings", () => {
    const text = '{"msg":"she said \\"hi\\"","ok":true}';
    expect(parseJsonObject(text)).toEqual({ msg: 'she said "hi"', ok: true });
  });

  it("returns null when no object is present", () => {
    expect(parseJsonObject("just prose, no json")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseJsonObject('{"a":1,"b":')).toBeNull();
  });
});
