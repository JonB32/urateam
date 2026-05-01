import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("OpenRouterClient", () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to /chat/completions with auth header and returns content + tokens", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 12, completion_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { OpenRouterClient } = await import("../executor/review/openrouter-client.js");
    const client = new OpenRouterClient({
      apiKey: "sk-or-test",
      baseUrl: "https://example.test/api/v1",
    });
    const result = await client.chatCompletion(
      "anthropic/claude-3.5-sonnet",
      [{ role: "user", content: "hi" }],
      { signal: new AbortController().signal },
    );
    expect(result).toEqual({ content: "hello", inputTokens: 12, outputTokens: 7 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/api/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-or-test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["HTTP-Referer"]).toBe("https://urateams.com");
    expect(headers["X-Title"]).toBe("urateam");
  });

  it("throws on non-2xx with status and snippet of body", async () => {
    fetchMock.mockResolvedValue(
      new Response("rate limited bro", { status: 429 }),
    );
    const { OpenRouterClient } = await import("../executor/review/openrouter-client.js");
    const client = new OpenRouterClient({ apiKey: "k", baseUrl: "https://example.test/api/v1" });
    await expect(
      client.chatCompletion("m", [{ role: "user", content: "x" }], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/openrouter 429/);
  });

  it("propagates AbortController abort as a rejection", async () => {
    const ac = new AbortController();
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const { OpenRouterClient } = await import("../executor/review/openrouter-client.js");
    const client = new OpenRouterClient({ apiKey: "k", baseUrl: "https://example.test/api/v1" });
    const p = client.chatCompletion("m", [{ role: "user", content: "x" }], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});
