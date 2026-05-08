import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the logger BEFORE importing the module under test so the module-level
// `const log = createLogger(...)` in review-provider.ts captures our spies.
//
// Variable names must start with "mock" so Vitest's static hoisting transform
// can safely reference them inside the vi.mock factory (hoisted variable rule).
// ---------------------------------------------------------------------------

const mockWarn = vi.fn();
const mockDebug = vi.fn();

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    warn: mockWarn,
    debug: mockDebug,
    info: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  }),
}));

import { validateReviewModels } from "../executor/review/review-provider.js";

// ---------------------------------------------------------------------------
// Fake catalog used across tests
// ---------------------------------------------------------------------------

const CATALOG_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "openai/gpt-4o",
  "anthropic/claude-3-haiku",
  "google/gemini-2.5-pro",
  "mistralai/mistral-7b-instruct",
];

const CATALOG_RESPONSE = {
  data: CATALOG_MODELS.map((id) => ({ id })),
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  mockWarn.mockReset();
  mockDebug.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateReviewModels", () => {
  it("returns silently when REVIEW_MODELS is not set", async () => {
    await validateReviewModels({ OPENROUTER_API_KEY: "sk" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns silently when OPENROUTER_API_KEY is not set", async () => {
    await validateReviewModels({ REVIEW_MODELS: "openai/gpt-4o" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns silently when both vars are unset", async () => {
    await validateReviewModels({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("emits no warn for a valid model (meta-llama/llama-3.3-70b-instruct:free) in the catalog", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(CATALOG_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await validateReviewModels({
      REVIEW_MODELS: "meta-llama/llama-3.3-70b-instruct:free",
      OPENROUTER_API_KEY: "sk-or-test",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("emits log.warn for an unknown model (wrong/model:free) with 3 closest suggestions", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(CATALOG_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await validateReviewModels({
      REVIEW_MODELS: "wrong/model:free",
      OPENROUTER_API_KEY: "sk-or-test",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    // warn must fire exactly once (one unknown model)
    expect(mockWarn).toHaveBeenCalledOnce();

    const [obj, msg] = mockWarn.mock.calls[0] as [{ model: string; available: string[] }, string];
    // Must include the invalid model ID
    expect(obj.model).toBe("wrong/model:free");
    // Must include closest-name suggestions (up to 3)
    expect(Array.isArray(obj.available)).toBe(true);
    expect(obj.available.length).toBeGreaterThanOrEqual(1);
    expect(obj.available.length).toBeLessThanOrEqual(3);
    // All suggestions must be real catalog IDs
    for (const suggestion of obj.available) {
      expect(CATALOG_MODELS).toContain(suggestion);
    }
    // Message must reference the catalog
    expect(msg).toMatch(/not found in OpenRouter catalog/);
  });

  it("emits only debug (no warn) when the catalog fetch fails with a network error", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    await validateReviewModels({
      REVIEW_MODELS: "openai/gpt-4o",
      OPENROUTER_API_KEY: "sk-or-test",
    });

    // No warn must fire
    expect(mockWarn).not.toHaveBeenCalled();
    // At least one debug must fire
    expect(mockDebug).toHaveBeenCalled();
    // The debug message must mention the failure
    const debugMessages = mockDebug.mock.calls.map(
      (args: unknown[]) => args[1] as string,
    );
    expect(debugMessages.some((m) => /catalog fetch failed|skipping/i.test(m))).toBe(true);
  });

  it("emits only debug (no warn) when the catalog endpoint returns a non-2xx status", async () => {
    fetchMock.mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    await validateReviewModels({
      REVIEW_MODELS: "openai/gpt-4o",
      OPENROUTER_API_KEY: "sk-or-test",
    });

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockDebug).toHaveBeenCalled();
    const debugMessages = mockDebug.mock.calls.map(
      (args: unknown[]) => args[1] as string,
    );
    expect(debugMessages.some((m) => /non-2xx|skipping/i.test(m))).toBe(true);
  });

  it("uses the configured OPENROUTER_BASE_URL for the catalog endpoint when set", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await validateReviewModels({
      REVIEW_MODELS: "openai/gpt-4o",
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_BASE_URL: "https://custom.example.test/api/v1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("https://custom.example.test/api/v1/models");
  });

  it("warns for each invalid model independently when multiple are configured", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "openai/gpt-4o" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await validateReviewModels({
      REVIEW_MODELS: "bad/model-one,openai/gpt-4o,bad/model-two",
      OPENROUTER_API_KEY: "sk-or-test",
    });

    // Two warn lines expected (one per invalid model), NOT for the valid one
    expect(mockWarn).toHaveBeenCalledTimes(2);
    const warnedModels = mockWarn.mock.calls.map(
      (args: unknown[]) => (args[0] as { model: string }).model,
    );
    expect(warnedModels).toContain("bad/model-one");
    expect(warnedModels).toContain("bad/model-two");
    expect(warnedModels).not.toContain("openai/gpt-4o");
  });
});
