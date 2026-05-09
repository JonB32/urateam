import { describe, it, expect } from "vitest";
import { consumeAgentStream } from "../executor/agent-stream.js";

describe("consumeAgentStream — cache tokens (BEC: cache telemetry)", () => {
  it("accumulates cache_creation_input_tokens and cache_read_input_tokens from message.usage", async () => {
    async function* fakeStream() {
      yield { type: "assistant", usage: { input_tokens: 100, cache_creation_input_tokens: 5000, cache_read_input_tokens: 0, output_tokens: 200 }, content: [{ type: "text", text: "" }] };
      yield { type: "assistant", usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 300 }, content: [{ type: "text", text: "" }] };
      yield { type: "assistant", usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 250 }, content: [{ type: "text", text: "done" }] };
    }
    const result = await consumeAgentStream(fakeStream());
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(750);
    expect(result.cacheCreationInputTokens).toBe(5000);
    expect(result.cacheReadInputTokens).toBe(10000);
  });

  it("treats missing cache fields as 0 (backward compat with non-cache responses)", async () => {
    async function* fakeStream() {
      yield { type: "assistant", usage: { input_tokens: 100, output_tokens: 200 }, content: [{ type: "text", text: "" }] };
    }
    const result = await consumeAgentStream(fakeStream());
    expect(result.cacheCreationInputTokens).toBe(0);
    expect(result.cacheReadInputTokens).toBe(0);
  });
});
