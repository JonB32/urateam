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

/**
 * Validates that every model ID in env.REVIEW_MODELS exists in the OpenRouter
 * catalog. Called at CLI startup (packages/cli/src/commands/start.ts and
 * packages/cli/src/commands/dev.ts) when both REVIEW_MODELS and
 * OPENROUTER_API_KEY are set.
 *
 * Never throws and never blocks startup — if the catalog endpoint is
 * unreachable, a debug log is emitted and validation is skipped. For each
 * unknown model ID a warn is emitted with up to 3 closest-name suggestions so
 * operators can correct typos before they burn API budget on silent 404s.
 *
 * @param env - The process environment (NodeJS.ProcessEnv)
 * @returns Promise<void> — always resolves.
 */
export async function validateReviewModels(env: NodeJS.ProcessEnv): Promise<void> {
  const rawModels = env.REVIEW_MODELS ?? "";
  const models = rawModels.split(",").map((s) => s.trim()).filter(Boolean);
  const apiKey = env.OPENROUTER_API_KEY ?? "";

  // Only run when both vars are configured — same symmetric requirement as
  // getEnabledProviders. Return silently when either is absent.
  if (models.length === 0 || !apiKey) return;

  const baseUrl = env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
  const catalogUrl = `${baseUrl}/models`;

  let catalogIds: string[];
  try {
    const resp = await fetch(catalogUrl, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) {
      log.debug(
        { status: resp.status, url: catalogUrl },
        "OpenRouter catalog fetch returned non-2xx; skipping REVIEW_MODELS validation",
      );
      return;
    }
    const body = (await resp.json()) as { data?: { id: string }[] };
    catalogIds = (body.data ?? []).map((m) => m.id);
  } catch (err) {
    log.debug(
      { err, url: catalogUrl },
      "OpenRouter catalog fetch failed; skipping REVIEW_MODELS validation",
    );
    return;
  }

  const catalogSet = new Set(catalogIds);
  for (const model of models) {
    if (catalogSet.has(model)) continue;
    const available = findClosestMatches(model, catalogIds, 3);
    log.warn(
      { model, available },
      "REVIEW_MODELS entry not found in OpenRouter catalog — fanout will 404",
    );
  }
}

/** Returns the `n` catalog IDs closest to `target` by Levenshtein distance. */
function findClosestMatches(target: string, candidates: string[], n: number): string[] {
  return candidates
    .map((c) => ({ id: c, dist: levenshtein(target, c) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n)
    .map((x) => x.id);
}

/** Space-optimised single-row Levenshtein distance. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
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
