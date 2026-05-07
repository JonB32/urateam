import type { HandoffArtifact, ReviewFinding } from "../../types.js";
import { AgenticDeepReviewProvider } from "./agentic-deep-review.js";
import { OpenRouterFanoutProvider } from "./openrouter-fanout.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ component: "review.provider" });

export type ReviewProviderId = "agentic" | "openrouter";

export interface ReviewContext {
  runId: string;
  stageRunId: string;
  workdir: string;
  handoff: HandoffArtifact;
  baseRef: string;
  prNumber: number | null;
}

export interface ReviewModelRun {
  modelId: string;
  providerId: ReviewProviderId;
  status: "completed" | "failed";
  findings: ReviewFinding[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  errorMessage?: string;
  truncatedFiles?: number;
  /** Raw model output, set when structured findings parse failed. */
  rawOutput?: string;
}

export interface ReviewProvider {
  readonly id: ReviewProviderId;
  runReview(ctx: ReviewContext): Promise<ReviewModelRun[]>;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_INPUT_TOKENS = 150_000;
/**
 * Below this, a structured-finding response can't even fit a small JSON
 * envelope — the fanout would silently produce truncated garbage on every
 * model, the same zero-findings symptom BEC-164 was meant to fix, just from
 * a different cause. Operators get a warn but the value is still applied
 * (no auto-correction — preserves operator intent for unusual setups).
 */
const SANE_OUTPUT_TOKENS_FLOOR = 256;

export function getEnabledProviders(env: NodeJS.ProcessEnv): ReviewProvider[] {
  const providers: ReviewProvider[] = [new AgenticDeepReviewProvider()];

  const rawModels = env.REVIEW_MODELS ?? "";
  const models = rawModels.split(",").map((s) => s.trim()).filter(Boolean);
  const apiKey = env.OPENROUTER_API_KEY ?? "";
  const fanoutDesired = models.length > 0;
  const keyPresent = apiKey.length > 0;

  if (fanoutDesired && !keyPresent) {
    throw new Error(
      "REVIEW_MODELS is set but OPENROUTER_API_KEY is missing — both must be set or both unset.",
    );
  }
  if (keyPresent && !fanoutDesired) {
    throw new Error(
      "OPENROUTER_API_KEY is set but REVIEW_MODELS is missing or empty — both must be set or both unset.",
    );
  }
  if (!fanoutDesired) return providers;

  // BEC-164: optional output-token cap. Unset = the model's provider default
  // applies (can be huge → 402s on limited-budget accounts). Invalid input
  // falls through to undefined so the cap stays unset.
  const maxOutputTokens = parsePositiveIntOrUndefined(env.REVIEW_MODELS_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens !== undefined && maxOutputTokens < SANE_OUTPUT_TOKENS_FLOOR) {
    log.warn(
      {
        var: "REVIEW_MODELS_MAX_OUTPUT_TOKENS",
        value: maxOutputTokens,
        floor: SANE_OUTPUT_TOKENS_FLOOR,
      },
      "REVIEW_MODELS_MAX_OUTPUT_TOKENS is below the sane floor — model responses will likely be truncated mid-finding and produce zero parseable output. Consider setting it to at least 1024.",
    );
  }

  providers.push(
    new OpenRouterFanoutProvider({
      apiKey,
      baseUrl: env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL,
      models,
      timeoutMs: parseIntOr(env.REVIEW_MODELS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      maxInputTokens: parseIntOr(env.REVIEW_MODELS_MAX_INPUT_TOKENS, DEFAULT_MAX_INPUT_TOKENS),
      maxOutputTokens,
    }),
  );
  return providers;
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePositiveIntOrUndefined(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
