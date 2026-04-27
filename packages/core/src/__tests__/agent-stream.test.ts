import { describe, it, expect } from "vitest";
import { consumeAgentStream, StageStalledError } from "../executor/agent-stream.js";

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
      expect(stalled.stalledForMs).toBeGreaterThanOrEqual(200);
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
