/**
 * createAgentProvider — factory that resolves the AgentProvider for a given stage.
 *
 * Provider selection (highest → lowest precedence):
 *  1. `IMPLEMENT_PROVIDER` environment variable (implement stage only)
 *  2. `stageProviders[stage]` from pipeline configuration
 *  3. Default: `"anthropic-sdk"` for all stages
 *
 * Only the implement stage currently supports non-Anthropic providers.
 * All other stages always use AnthropicAgentSDK regardless of configuration.
 *
 * @param stage - Current pipeline stage name.
 * @param stageProviders - Optional per-stage provider overrides from PipelineConfig.
 * @param env - Optional environment variable map (defaults to process.env).
 * @returns Resolved AgentProvider instance.
 */

import type { AgentProvider } from "./index.js";
import { AnthropicAgentSDK } from "./anthropic-agent.js";
import { OpenRouterAgent } from "./openrouter-agent.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "provider.factory" });

const IMPLEMENT_STAGE = "implement";

export function createAgentProvider(
  stage: string,
  stageProviders?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): AgentProvider {
  // Only implement stage supports non-Anthropic providers in v1.
  if (stage !== IMPLEMENT_STAGE) {
    return new AnthropicAgentSDK();
  }

  // Resolve provider ID: env var > config > default.
  const rawProvider =
    env.IMPLEMENT_PROVIDER ??
    stageProviders?.[stage] ??
    "anthropic-sdk";

  const providerId = rawProvider.toLowerCase().trim();

  switch (providerId) {
    case "anthropic-sdk":
      return new AnthropicAgentSDK();

    case "openrouter":
      log.info({ provider: "openrouter" }, "implement stage using OpenRouter provider");
      return new OpenRouterAgent();

    default:
      log.warn(
        { providerId, fallback: "anthropic-sdk" },
        "Unknown IMPLEMENT_PROVIDER value — falling back to anthropic-sdk",
      );
      return new AnthropicAgentSDK();
  }
}
