/**
 * BEC-201: multi-AI provider support — unit + integration tests.
 *
 * Verifies:
 *  1. AgentProvider interface is exported from executor/provider/index.ts
 *  2. createAgentProvider factory returns the correct provider per env var / config
 *  3. AnthropicAgentSDK.execute() calls query() with the correct model config
 *  4. OpenRouterAgent.execute() calls the OpenRouter API and parses the response
 *  5. Factory returns AnthropicAgentSDK for non-implement stages regardless of IMPLEMENT_PROVIDER
 *  6. Provider failure throws a descriptive error
 *  7. executeStage() uses the provider and persists providerName + modelId to DB
 *  8. End-to-end: executeStage() with OpenRouter provider produces valid HandoffArtifact
 *
 * External dependencies mocked:
 *  - @anthropic-ai/claude-agent-sdk (query)
 *  - ../executor/auth-check.js (isClaudeAuthValid)
 *  - ../executor/extract-handoff.js (extractHandoff)
 *  - fetch (for OpenRouter HTTP calls)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module mocks (hoisted before imports) ────────────────────────────────────

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../executor/auth-check.js", () => ({
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
}));

vi.mock("../executor/extract-handoff.js", () => ({
  extractHandoff: vi.fn().mockResolvedValue({
    artifact: {
      runId: "test-run",
      issueId: "BEC-201",
      stage: "implement",
      timestamp: new Date().toISOString(),
      summary: "Implemented multi-AI provider support",
      filesChanged: ["src/executor/provider/index.ts"],
      approach: "Added AgentProvider interface with Anthropic and OpenRouter implementations",
      context: {
        issueIntent: "Support multiple AI providers for the implement stage",
        constraints: [],
        assumptions: [],
      },
      tokenBudget: { contextTokensUsed: 1000, recommendedMaxTurns: 5 },
    },
    structured: true,
  }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { createDb, type Db } from "../db/client.js";
import { pipelineRuns, stageRuns } from "../db/schema.js";
import { executeStage } from "../executor/executor.js";
import {
  createAgentProvider,
  AnthropicAgentSDK,
  OpenRouterAgent,
  type AgentProvider,
  type AgentExecuteParams,
} from "../executor/provider/index.js";
import type { SanitizedIssue, RepoConfig } from "../types.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testIssue: SanitizedIssue = {
  id: "BEC-201",
  slug: "multi-ai-provider-support",
  title: "Multi-AI provider support for implement stage",
  description: "Support multiple AI providers for the implement stage.",
  acceptanceCriteria: ["AgentProvider interface exported", "OpenRouter provider works"],
  labels: ["auto-implement"],
  priority: 2,
};

const testRepoConfig: RepoConfig = {
  url: "https://github.com/test-org/test-repo",
  defaultBranch: "main",
  testCommand: "echo ok",
  buildCommand: "echo ok",
};

/** A minimal async-generator that produces one assistant message and then ends. */
function makeMinimalStream() {
  return (async function* () {
    yield {
      type: "assistant",
      content: [{ type: "text", text: "Implementation complete." }],
    };
  })();
}

/** A HandoffArtifact JSON block for use in mock responses. */
const MOCK_HANDOFF_JSON = JSON.stringify({
  summary: "Implemented multi-AI provider support",
  filesChanged: ["src/executor/provider/index.ts"],
  approach: "Added AgentProvider interface",
  context: {
    issueIntent: "Support multiple AI providers",
    constraints: [],
    assumptions: [],
  },
  tokenBudget: { contextTokensUsed: 500, recommendedMaxTurns: 3 },
}, null, 2);

const MOCK_OPENROUTER_TEXT = `
Here is my analysis and plan:

\`\`\`json
${MOCK_HANDOFF_JSON}
\`\`\`
`;

async function createTestDb(): Promise<Db> {
  return createDb({ connectionString: ":memory:" });
}

async function seedPipelineRun(db: Db, runId: string): Promise<void> {
  await (db as any).insert(pipelineRuns).values({
    id: runId,
    issueId: testIssue.id,
    issueTitle: testIssue.title,
    pipelineKey: "auto-implement",
    repoUrl: testRepoConfig.url,
    branch: `agent/${runId}`,
    status: "running",
  });
}

// ── Tests: AgentProvider interface ────────────────────────────────────────────

describe("AgentProvider interface (BEC-201)", () => {
  it("is exported from executor/provider/index.ts", async () => {
    // Verify the types compile and the classes are instantiable
    const anthropic: AgentProvider = new AnthropicAgentSDK();
    const openrouter: AgentProvider = new OpenRouterAgent();

    expect(anthropic.providerId).toBe("anthropic-sdk");
    expect(openrouter.providerId).toBe("openrouter");
    expect(typeof anthropic.execute).toBe("function");
    expect(typeof openrouter.execute).toBe("function");
  });

  it("createAgentProvider is exported and callable", () => {
    expect(typeof createAgentProvider).toBe("function");
  });
});

// ── Tests: createAgentProvider factory ───────────────────────────────────────

describe("createAgentProvider factory (BEC-201)", () => {
  afterEach(() => {
    // Clean up env var overrides
    delete process.env.IMPLEMENT_PROVIDER;
  });

  it("returns AnthropicAgentSDK by default (no env var, no stageProviders)", () => {
    const provider = createAgentProvider("implement");
    expect(provider.providerId).toBe("anthropic-sdk");
    expect(provider).toBeInstanceOf(AnthropicAgentSDK);
  });

  it("returns OpenRouterAgent when IMPLEMENT_PROVIDER=openrouter", () => {
    const provider = createAgentProvider("implement", undefined, { IMPLEMENT_PROVIDER: "openrouter" });
    expect(provider.providerId).toBe("openrouter");
    expect(provider).toBeInstanceOf(OpenRouterAgent);
  });

  it("IMPLEMENT_PROVIDER env var takes precedence over stageProviders config", () => {
    const provider = createAgentProvider(
      "implement",
      { implement: "anthropic-sdk" }, // config says anthropic
      { IMPLEMENT_PROVIDER: "openrouter" }, // env says openrouter → wins
    );
    expect(provider.providerId).toBe("openrouter");
  });

  it("uses stageProviders config when IMPLEMENT_PROVIDER is not set", () => {
    const provider = createAgentProvider(
      "implement",
      { implement: "openrouter" },
      {}, // no IMPLEMENT_PROVIDER
    );
    expect(provider.providerId).toBe("openrouter");
  });

  it("returns AnthropicAgentSDK for non-implement stages regardless of IMPLEMENT_PROVIDER", () => {
    for (const stage of ["triage", "reproduce", "test", "review"]) {
      const provider = createAgentProvider(stage, undefined, { IMPLEMENT_PROVIDER: "openrouter" });
      expect(provider.providerId).toBe("anthropic-sdk");
      expect(provider).toBeInstanceOf(AnthropicAgentSDK);
    }
  });

  it("falls back to AnthropicAgentSDK for unknown provider IDs with a warning", () => {
    // Should not throw — unknown values produce a fallback
    const provider = createAgentProvider("implement", undefined, { IMPLEMENT_PROVIDER: "unknown-provider" });
    expect(provider.providerId).toBe("anthropic-sdk");
  });
});

// ── Tests: AnthropicAgentSDK provider ────────────────────────────────────────

describe("AnthropicAgentSDK.execute() (BEC-201)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls query() with the correct model from modelConfig", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    const provider = new AnthropicAgentSDK();
    const result = await provider.execute({
      prompt: "Implement feature X",
      workdir: "/tmp/test-workdir",
      stage: "implement",
      profile: {
        tools: ["Read", "Write", "Edit"],
        maxTurns: 50,
        maxInputTokens: 100_000,
        model: "claude-sonnet-4-6",
      },
      modelConfig: { model: "claude-opus-4-6" }, // override to Opus
      runId: "test-run-1",
      issueId: "BEC-201",
    });

    expect(query).toHaveBeenCalledOnce();
    const callOptions = (query as any).mock.calls[0][0].options;
    expect(callOptions.model).toBe("claude-opus-4-6"); // modelConfig wins
    expect(result.providerName).toBe("anthropic-sdk");
    expect(result.modelId).toBe("claude-opus-4-6");
  });

  it("falls back to profile.model when modelConfig.model is not set", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    const provider = new AnthropicAgentSDK();
    await provider.execute({
      prompt: "Implement feature X",
      workdir: "/tmp/test-workdir",
      stage: "implement",
      profile: {
        tools: ["Read", "Write"],
        maxTurns: 50,
        maxInputTokens: 100_000,
        model: "claude-sonnet-4-6",
      },
      modelConfig: {}, // no override
      runId: "test-run-2",
      issueId: "BEC-201",
    });

    const callOptions = (query as any).mock.calls[0][0].options;
    expect(callOptions.model).toBe("claude-sonnet-4-6"); // profile default
  });

  it("calls onToolMessage callback for each tool event", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue((async function* () {
      yield { type: "tool_use", id: "tool-1", name: "Read", input: {} };
      yield { type: "assistant", content: [{ type: "text", text: "Done." }] };
    })());

    const toolMessages: unknown[] = [];
    const provider = new AnthropicAgentSDK();
    await provider.execute({
      prompt: "Test prompt",
      workdir: "/tmp/workdir",
      stage: "implement",
      profile: { tools: ["Read"], maxTurns: 10, maxInputTokens: 50_000 },
      modelConfig: {},
      runId: "test-run-3",
      issueId: "BEC-201",
      onToolMessage: (msg) => toolMessages.push(msg),
    });

    expect(toolMessages.length).toBeGreaterThan(0);
  });

  it("returns providerName=anthropic-sdk and modelId in the result", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    const provider = new AnthropicAgentSDK();
    const result = await provider.execute({
      prompt: "Test",
      workdir: "/tmp/workdir",
      stage: "test",
      profile: { tools: ["Read"], maxTurns: 5, maxInputTokens: 10_000, model: "claude-haiku-4-5" },
      modelConfig: {},
      runId: "test-run-4",
      issueId: "BEC-201",
    });

    expect(result.providerName).toBe("anthropic-sdk");
    expect(result.modelId).toBe("claude-haiku-4-5");
  });
});

// ── Tests: OpenRouterAgent provider ──────────────────────────────────────────

describe("OpenRouterAgent.execute() (BEC-201)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Replace global fetch with a mock
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.IMPLEMENT_OPENROUTER_MODEL;
  });

  function makeFetchResponse(content: string, inputTokens = 100, outputTokens = 200) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
      }),
    } as Response);
  }

  it("throws when OPENROUTER_API_KEY is not set", async () => {
    const provider = new OpenRouterAgent();
    await expect(provider.execute({
      prompt: "Test",
      workdir: "/tmp/workdir",
      stage: "implement",
      profile: { tools: [], maxTurns: 1, maxInputTokens: 10_000 },
      modelConfig: {},
      runId: "test-run-5",
      issueId: "BEC-201",
    })).rejects.toThrow("OPENROUTER_API_KEY");
  });

  it("calls OpenRouter API with the correct model from modelConfig", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-123";
    mockFetch.mockReturnValue(makeFetchResponse(MOCK_OPENROUTER_TEXT));

    const provider = new OpenRouterAgent();
    const result = await provider.execute({
      prompt: "Implement feature X",
      workdir: "/tmp/workdir",
      stage: "implement",
      profile: { tools: [], maxTurns: 1, maxInputTokens: 50_000 },
      modelConfig: { model: "openai/gpt-4o" },
      runId: "test-run-6",
      issueId: "BEC-201",
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/chat/completions");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("openai/gpt-4o");
    expect(result.providerName).toBe("openrouter");
    expect(result.modelId).toBe("openai/gpt-4o");
  });

  it("uses IMPLEMENT_OPENROUTER_MODEL env var when modelConfig.model is not set", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-123";
    process.env.IMPLEMENT_OPENROUTER_MODEL = "google/gemini-pro";
    mockFetch.mockReturnValue(makeFetchResponse(MOCK_OPENROUTER_TEXT));

    const provider = new OpenRouterAgent();
    const result = await provider.execute({
      prompt: "Implement feature X",
      workdir: "/tmp/workdir",
      stage: "implement",
      profile: { tools: [], maxTurns: 1, maxInputTokens: 50_000 },
      modelConfig: {}, // no override
      runId: "test-run-7",
      issueId: "BEC-201",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe("google/gemini-pro");
    expect(result.modelId).toBe("google/gemini-pro");
  });

  it("returns parsed token counts from OpenRouter response", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-123";
    mockFetch.mockReturnValue(makeFetchResponse(MOCK_OPENROUTER_TEXT, 1500, 800));

    const provider = new OpenRouterAgent();
    const result = await provider.execute({
      prompt: "Test",
      workdir: "/tmp/workdir",
      stage: "implement",
      profile: { tools: [], maxTurns: 1, maxInputTokens: 50_000 },
      modelConfig: { model: "anthropic/claude-sonnet-4-5" },
      runId: "test-run-8",
      issueId: "BEC-201",
    });

    expect(result.inputTokens).toBe(1500);
    expect(result.outputTokens).toBe(800);
    expect(result.cacheCreationInputTokens).toBe(0); // not supported
    expect(result.cacheReadInputTokens).toBe(0); // not supported
    expect(result.turns).toBe(1); // one-shot
  });

  it("returns lastText containing the HandoffArtifact JSON block", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-123";
    mockFetch.mockReturnValue(makeFetchResponse(MOCK_OPENROUTER_TEXT));

    const provider = new OpenRouterAgent();
    const result = await provider.execute({
      prompt: "Implement feature X",
      workdir: "/tmp/workdir",
      stage: "implement",
      profile: { tools: [], maxTurns: 1, maxInputTokens: 50_000 },
      modelConfig: { model: "anthropic/claude-sonnet-4-5" },
      runId: "test-run-9",
      issueId: "BEC-201",
    });

    expect(result.lastText).toContain("```json");
    expect(result.lastText).toContain("summary");
    expect(result.lastText).toContain("filesChanged");
  });

  it("throws a descriptive error when OpenRouter returns a non-OK HTTP status", async () => {
    process.env.OPENROUTER_API_KEY = "test-key-123";
    mockFetch.mockReturnValue(Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    } as unknown as Response));

    const provider = new OpenRouterAgent();
    await expect(provider.execute({
      prompt: "Test",
      workdir: "/tmp/workdir",
      stage: "implement",
      profile: { tools: [], maxTurns: 1, maxInputTokens: 50_000 },
      modelConfig: { model: "openai/gpt-4o" },
      runId: "test-run-10",
      issueId: "BEC-201",
    })).rejects.toThrow(/OpenRouterAgent.*failed.*openai\/gpt-4o/);
  });
});

// ── Tests: executeStage() provider integration ────────────────────────────────

describe("executeStage() with provider selection (BEC-201)", () => {
  let db: Db;

  beforeEach(async () => {
    db = await createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.IMPLEMENT_PROVIDER;
  });

  it("uses AnthropicAgentSDK (default) and persists provider/model to DB", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    const runId = "bec201-default-run";
    await seedPipelineRun(db, runId);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec201-workdir",
      db,
      stageModels: { implement: "claude-opus-4-6" },
    });

    expect(result.status).toBe("completed");
    expect(query).toHaveBeenCalledOnce();

    // Verify provider/model persisted to DB
    const rows = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, runId));

    expect(rows).toHaveLength(1);
    expect(rows[0].providerName).toBe("anthropic-sdk");
    expect(rows[0].modelId).toBe("claude-opus-4-6");
  });

  it("query() is called with correct model for IMPLEMENT_PROVIDER=anthropic-sdk", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    process.env.IMPLEMENT_PROVIDER = "anthropic-sdk";

    const runId = "bec201-explicit-anthropic";
    await seedPipelineRun(db, runId);

    await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec201-workdir",
      db,
      stageModels: { implement: "claude-sonnet-4-6" },
    });

    expect(query).toHaveBeenCalledOnce();
    const callOptions = (query as any).mock.calls[0][0].options;
    expect(callOptions.model).toBe("claude-sonnet-4-6");
  });

  it("uses stageProviders config for provider selection", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    (query as any).mockReturnValue(makeMinimalStream());

    const runId = "bec201-stage-providers";
    await seedPipelineRun(db, runId);

    // stageProviders explicitly sets "anthropic-sdk" (default, just testing config path)
    await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec201-workdir",
      db,
      stageProviders: { implement: "anthropic-sdk" },
    });

    expect(query).toHaveBeenCalledOnce();

    const rows = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, runId));

    expect(rows[0].providerName).toBe("anthropic-sdk");
  });
});

// ── End-to-end test: OpenRouter provider mock ─────────────────────────────────

describe("executeStage() end-to-end with mocked OpenRouter (BEC-201 AC-6)", () => {
  let db: Db;
  const mockFetch = vi.fn();

  beforeEach(async () => {
    db = await createTestDb();
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
    process.env.IMPLEMENT_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "test-key-openrouter";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.IMPLEMENT_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("executes implement stage via OpenRouter, persists provider/model, returns valid HandoffArtifact", async () => {
    // Mock OpenRouter API response
    mockFetch.mockReturnValue(Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: MOCK_OPENROUTER_TEXT } }],
        usage: { prompt_tokens: 2000, completion_tokens: 500 },
      }),
    } as Response));

    const runId = "bec201-openrouter-e2e";
    await seedPipelineRun(db, runId);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec201-workdir",
      db,
      stageModels: { implement: "openai/gpt-4o" },
      stageProviders: { implement: "openrouter" }, // also set via env var above
    });

    // OpenRouter was called (not the Anthropic SDK)
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    expect(query).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();

    // Overall stage status
    expect(result.status).toBe("completed");

    // HandoffArtifact is returned (extracted by mocked extractHandoff)
    expect(result.handoffArtifact).toBeDefined();
    expect(result.handoffArtifact!.runId).toBe(runId);
    expect(result.handoffArtifact!.issueId).toBe(testIssue.id);
    expect(result.handoffArtifact!.stage).toBe("implement");
    expect(typeof result.handoffArtifact!.summary).toBe("string");
    expect(Array.isArray(result.handoffArtifact!.filesChanged)).toBe(true);

    // Provider/model persisted to DB
    const rows = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, runId));

    expect(rows).toHaveLength(1);
    expect(rows[0].providerName).toBe("openrouter");
    expect(rows[0].modelId).toBe("openai/gpt-4o");
    expect(rows[0].inputTokens).toBe(2000);
    expect(rows[0].outputTokens).toBe(500);
    expect(rows[0].status).toBe("completed");
  });

  it("records failed stage with providerName when OpenRouter API call fails", async () => {
    // Mock a failing API response
    mockFetch.mockReturnValue(Promise.resolve({
      ok: false,
      status: 503,
      text: () => Promise.resolve("Service Unavailable"),
    } as unknown as Response));

    const runId = "bec201-openrouter-failure";
    await seedPipelineRun(db, runId);

    const result = await executeStage({
      runId,
      issueId: testIssue.id,
      stage: "implement",
      sanitizedIssue: testIssue,
      repoConfig: testRepoConfig,
      workdir: "/tmp/bec201-workdir",
      db,
      stageModels: { implement: "openai/gpt-4o" },
    });

    // Stage fails with descriptive error
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("OpenRouterAgent");

    // Failed stage also records the provider in DB
    const rows = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, runId));

    expect(rows[0].status).toBe("failed");
    expect(rows[0].providerName).toBe("openrouter");
    expect(rows[0].errorMessage).toContain("OpenRouterAgent");
  });
});

// ── Tests: DB schema has provider_name and model_id columns ──────────────────

describe("stage_runs DB schema — provider_name and model_id columns (BEC-201)", () => {
  it("stage_runs table includes provider_name and model_id after migration", async () => {
    const db = await createTestDb();
    const runId = "bec201-schema-test";
    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-201",
      issueTitle: "Test",
      pipelineKey: "default",
      repoUrl: "https://github.com/test/repo",
      branch: "main",
      status: "running",
    });

    const { nanoid } = await import("nanoid");
    const stageRunId = nanoid();

    // Insert a stage run with provider/model info
    await (db as any).insert(stageRuns).values({
      id: stageRunId,
      pipelineRunId: runId,
      stage: "implement",
      status: "completed",
      providerName: "openrouter",
      modelId: "openai/gpt-4o",
    });

    const rows = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, runId));

    expect(rows).toHaveLength(1);
    expect(rows[0].providerName).toBe("openrouter");
    expect(rows[0].modelId).toBe("openai/gpt-4o");
  });

  it("provider_name and model_id default to null for legacy rows", async () => {
    const db = await createTestDb();
    const runId = "bec201-schema-null-test";
    await (db as any).insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-201",
      issueTitle: "Test",
      pipelineKey: "default",
      repoUrl: "https://github.com/test/repo",
      branch: "main",
      status: "running",
    });

    const { nanoid } = await import("nanoid");
    await (db as any).insert(stageRuns).values({
      id: nanoid(),
      pipelineRunId: runId,
      stage: "triage",
      status: "completed",
      // providerName and modelId omitted — should be null
    });

    const rows = await (db as any)
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, runId));

    expect(rows[0].providerName).toBeNull();
    expect(rows[0].modelId).toBeNull();
  });
});
