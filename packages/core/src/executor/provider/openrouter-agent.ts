/**
 * OpenRouterAgent — AgentProvider implementation using the OpenRouter chat-completion API.
 *
 * Routes implement-stage requests to OpenRouter, which gives access to 200+ models
 * (Claude, GPT, Gemini, Kimi, Llama, Mistral, …) via a single API key.
 *
 * ## How it works
 *  1. The assembled stage prompt is sent as a single user message.
 *  2. A system message instructs the model to output a HandoffArtifact JSON block.
 *  3. The raw text response is returned so the executor can extract the handoff.
 *
 * ## Prerequisites
 *  - `OPENROUTER_API_KEY` environment variable must be set.
 *  - Model is selected from (in order):
 *      1. `modelConfig.model` (from stageModels.implement or stageProviders.implement)
 *      2. `IMPLEMENT_OPENROUTER_MODEL` env var
 *      3. Default: `"anthropic/claude-sonnet-4-5"` (Claude via OpenRouter)
 *
 * ## Limitations vs. AnthropicAgentSDK
 *  - One-shot: the model cannot call tools or iterate over multiple turns.
 *  - No file-system access: the model produces a plan/handoff describing changes,
 *    but cannot write files directly. Suitable for planning/review stages or
 *    operators who post-process the output externally.
 *  - No prompt-cache: cacheCreationInputTokens and cacheReadInputTokens are always 0.
 *
 * ## Fallback behaviour on failure
 *  OpenRouterAgent throws a descriptive Error on API failure. The executor logs
 *  the error with the provider name and context, then either falls back to
 *  AnthropicAgentSDK (when `implementProviderFallback: true` is configured) or
 *  surfaces the error as a permanent stage failure.
 */

import type { AgentProvider, AgentExecuteParams, AgentExecuteResult } from "./index.js";
import { OpenRouterClient } from "../review/openrouter-client.js";
import { createLogger } from "../../logger.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const DEFAULT_TIMEOUT_MS = 120_000; // 2 min for chat completion

/**
 * System prompt instructing the model to produce HandoffArtifact JSON.
 * This is minimal context; the full stage prompt carries all issue detail.
 */
const HANDOFF_SYSTEM_PROMPT = `You are an expert software engineer helping implement a coding task.
You will receive a detailed task description and must produce a HandoffArtifact JSON block
summarising what you have done (or planned to do) for the next pipeline stage.

The HandoffArtifact JSON block MUST appear at the end of your response, wrapped exactly as:

\`\`\`json
{
  "summary": "<concise summary of changes / plan>",
  "filesChanged": ["<list of files changed or to be changed>"],
  "approach": "<description of the approach taken>",
  "context": {
    "issueIntent": "<what the issue asked for>",
    "constraints": ["<constraint 1>", "..."],
    "assumptions": ["<assumption 1>", "..."]
  },
  "tokenBudget": {
    "contextTokensUsed": 0,
    "recommendedMaxTurns": 1
  }
}
\`\`\`

Be thorough in your analysis and planning. Describe the implementation approach in detail.`;

export interface OpenRouterAgentConfig {
  /** OpenRouter API key. Defaults to OPENROUTER_API_KEY env var. */
  apiKey?: string;
  /** OpenRouter base URL. Defaults to https://openrouter.ai/api/v1. */
  baseUrl?: string;
  /** HTTP timeout in ms for each chat completion request. Default: 120 000. */
  timeoutMs?: number;
}

export class OpenRouterAgent implements AgentProvider {
  readonly providerId = "openrouter" as const;

  private readonly cfg: OpenRouterAgentConfig;

  constructor(cfg: OpenRouterAgentConfig = {}) {
    this.cfg = cfg;
  }

  async execute(params: AgentExecuteParams): Promise<AgentExecuteResult> {
    const { prompt, modelConfig, runId, issueId, stage } = params;

    const log = createLogger({ component: "provider.openrouter", runId, issueId, stage });

    const apiKey = this.cfg.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    if (!apiKey) {
      throw new Error(
        "OpenRouterAgent: OPENROUTER_API_KEY is not set. " +
        "Set it in the environment or pass apiKey in the provider config.",
      );
    }

    const baseUrl = this.cfg.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Model resolution: modelConfig.model > IMPLEMENT_OPENROUTER_MODEL env > default
    const modelId =
      modelConfig.model ??
      process.env.IMPLEMENT_OPENROUTER_MODEL ??
      DEFAULT_MODEL;

    log.info({ modelId, baseUrl }, "sending request to OpenRouter");

    const client = new OpenRouterClient({ apiKey, baseUrl });
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    let result;
    try {
      result = await client.chatCompletion(
        modelId,
        [
          { role: "system", content: HANDOFF_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        {
          signal: controller.signal,
          ...(modelConfig.maxTokens !== undefined ? { maxTokens: modelConfig.maxTokens } : {}),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, modelId, provider: "openrouter" }, "OpenRouter request failed");
      throw new Error(
        `OpenRouterAgent: provider call failed for model "${modelId}": ${message}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!result.content) {
      throw new Error(
        `OpenRouterAgent: model "${modelId}" returned empty content — ` +
        "cannot extract HandoffArtifact.",
      );
    }

    log.info(
      { inputTokens: result.inputTokens, outputTokens: result.outputTokens, modelId },
      "OpenRouter request completed",
    );

    return {
      lastText: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      // OpenRouter chat completions do not use Anthropic prompt-cache.
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      // One-shot: single turn.
      turns: 1,
      providerName: this.providerId,
      modelId,
    };
  }
}
