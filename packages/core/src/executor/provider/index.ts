/**
 * AgentProvider — multi-AI provider abstraction for pipeline stages (BEC-201).
 *
 * Enables operator-selectable AI backends for pipeline stages.
 * Default provider is AnthropicAgentSDK (unchanged behavior).
 * OpenRouter support routes via chat-completion to 200+ models.
 *
 * ## Provider selection (highest → lowest precedence)
 *  1. `IMPLEMENT_PROVIDER` environment variable
 *  2. `pipelineConfig.stageProviders[stage]` config field
 *  3. Default: `"anthropic-sdk"`
 *
 * ## Supported providers
 *  - `"anthropic-sdk"` — @anthropic-ai/claude-agent-sdk (agentic, tool-using). Default.
 *  - `"openrouter"` — OpenRouter chat-completion API (non-agentic one-shot). Requires
 *    `OPENROUTER_API_KEY` and `IMPLEMENT_OPENROUTER_MODEL` (or stageModels.implement).
 *
 * ## Provider failure behaviour
 *  When a non-Anthropic provider fails (API error, timeout, malformed response),
 *  the executor throws a clear error message. Callers may catch and fall back to
 *  AnthropicAgentSDK if desired — see executor.ts for the fallback path.
 */

/** Unique string identifier for each supported provider. */
export type ProviderId = "anthropic-sdk" | "openrouter";

/**
 * Model configuration passed from the executor to the provider.
 *
 * @property model — Model identifier to use (e.g. "claude-sonnet-4-6", "openai/gpt-4o").
 *   Overrides the agent profile's default model when set.
 * @property maxTokens — Optional maximum output tokens. Provider-specific default applies
 *   when unset.
 */
export interface ModelConfig {
  /** Model identifier (e.g., "claude-sonnet-4-6", "openai/gpt-4o"). */
  model?: string;
  /** Max output tokens for the provider call. Provider default applies if unset. */
  maxTokens?: number;
}

/**
 * Parameters passed to AgentProvider.execute().
 *
 * Input contract:
 *  - `prompt` is the fully-assembled stage prompt (sanitized, with all context injected).
 *  - `modelConfig.model` overrides `profile.model` when set.
 *  - `profile` carries tool list, turn cap, and token budget for Anthropic-SDK execution.
 *  - `stageTimeoutMs` and `firstMessageTimeoutMs` are Anthropic-SDK-specific timeout hints;
 *    other providers manage their own timeouts.
 */
export interface AgentExecuteParams {
  /** Fully-assembled stage prompt (sanitized). */
  prompt: string;
  /** Working directory (cwd for the agent / context for the request). */
  workdir: string;
  /** Pipeline stage name (e.g., "implement", "test"). */
  stage: string;
  /** Agent profile: tool allowlist, turn cap, token budget, and default model. */
  profile: {
    tools: string[];
    maxTurns: number;
    maxInputTokens: number;
    model?: string;
  };
  /** Effective model configuration for this execution. */
  modelConfig: ModelConfig;
  /** Pipeline run ID (for logging and DB tracking). */
  runId: string;
  /** Linear issue ID (for logging). */
  issueId: string;
  /** Resolved MCP server configs for this stage (Anthropic-SDK only). */
  mcpServers?: Record<string, unknown>;
  /** Resolved plugin descriptors for this stage (Anthropic-SDK only). */
  plugins?: unknown[];
  /**
   * Wall-clock stage timeout in milliseconds.
   * AnthropicAgentSDK uses this as the outer Promise.race deadline.
   * Other providers manage their own HTTP timeouts independently.
   */
  stageTimeoutMs?: number;
  /**
   * First-message timeout in milliseconds for the Anthropic Agent SDK stream.
   * Passed to consumeAgentStream as `firstMessageTimeoutMs`.
   * Other providers may ignore this parameter.
   */
  firstMessageTimeoutMs?: number;
  /** Progress callback (for structured logging). */
  onProgress?: (stats: Record<string, unknown>) => void;
  /** Tool-message callback (for DB agent-log batching in the executor). */
  onToolMessage?: (msg: unknown) => void;
}

/**
 * Raw execution result returned by AgentProvider.execute().
 *
 * Output contract:
 *  - `lastText` must contain a HandoffArtifact JSON block consumable by
 *    parseHandoffArtifact(). Falls back to an unstructured summary if absent.
 *  - Token counts are best-effort; may be 0 if the provider does not report usage.
 *  - `providerName` and `modelId` reflect the ACTUAL provider and model used
 *    (not the requested values), enabling accurate cost tracking.
 */
export interface AgentExecuteResult {
  /** Raw agent text output, expected to contain a HandoffArtifact JSON block. */
  lastText: string;
  /** Total input tokens consumed (prompt + context). */
  inputTokens: number;
  /** Total output/completion tokens generated. */
  outputTokens: number;
  /** Cache-creation input tokens (Anthropic prompt-cache feature; 0 for other providers). */
  cacheCreationInputTokens: number;
  /** Cache-read input tokens (Anthropic prompt-cache feature; 0 for other providers). */
  cacheReadInputTokens: number;
  /** Number of turns taken (≥1 for agentic providers; 1 for one-shot providers). */
  turns: number;
  /** Actual provider ID used for this execution. */
  providerName: string;
  /** Actual model ID used for this execution. */
  modelId: string;
}

/**
 * AgentProvider is the abstraction that decouples pipeline stages from a
 * specific AI runtime.
 *
 * ## Input contract
 *  - `params.prompt` is the fully-assembled stage prompt (sanitized, with context).
 *  - `params.modelConfig.model` overrides the profile model when set.
 *  - `params.profile` carries maxTurns, maxInputTokens, and tool list.
 *
 * ## Output contract (AgentExecuteResult)
 *  - `result.lastText` must contain a HandoffArtifact JSON block consumable
 *    by parseHandoffArtifact(). Falls back to unstructured if absent.
 *  - Token fields are best-effort; may be 0 if the provider does not report usage.
 *
 * ## Error types
 *  - Throws `Error` with a descriptive message on API failure, timeout, or
 *    malformed response. The executor logs the error with provider context and
 *    may fall back to AnthropicAgentSDK.
 */
export interface AgentProvider {
  /** Unique provider identifier (e.g., "anthropic-sdk", "openrouter"). */
  readonly providerId: ProviderId;

  /**
   * Execute a pipeline stage and return the raw result.
   *
   * @param params - Stage execution parameters (prompt, profile, model config, callbacks).
   * @returns Raw execution result including agent text output and token usage.
   * @throws {Error} On provider API error, timeout, or malformed response.
   */
  execute(params: AgentExecuteParams): Promise<AgentExecuteResult>;
}

export { AnthropicAgentSDK } from "./anthropic-agent.js";
export { OpenRouterAgent } from "./openrouter-agent.js";
export { createAgentProvider } from "./factory.js";
