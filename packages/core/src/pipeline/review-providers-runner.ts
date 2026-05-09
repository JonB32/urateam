import {
  getEnabledProviders,
  type ReviewContext,
  type ReviewModelRun,
} from "../executor/review/review-provider.js";
import { insertReviewModelRuns } from "../db/review-model-runs.js";
import type { AnyDb } from "../db/client.js";
import type { ReviewFinding } from "../types.js";
import { createLogger } from "../logger.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { reviewModelLowOutputRatioEvent } from "../audit/events.js";
import { getModelHealthScores, flagLowYieldModels } from "../executor/review/model-health.js";

const log = createLogger({ component: "ReviewProvidersRunner" });

function parseFloatOr(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback;
  const n = parseFloat(envValue);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function parseIntOr(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback;
  const n = parseInt(envValue, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface RunReviewProvidersOpts {
  env: NodeJS.ProcessEnv;
  db: AnyDb;
}

export interface RunReviewProvidersResult {
  agenticFindings: ReviewFinding[];
  totalInputTokens: number;
  totalOutputTokens: number;
  allRuns: ReviewModelRun[];
}

/**
 * Runs all enabled review providers in sequence and persists their per-model
 * results to `review_model_runs` when a stage_run row id is provided.
 *
 * Provider failures are caught and recorded as advisory `failed` runs rather
 * than rethrown, so a flaky third-party model can never fail the pipeline.
 *
 * Persistence is skipped when `ctx.stageRunId === ""` (callers without an
 * associated stage_runs row).
 *
 * BEC-134: this helper no longer posts fanout PR comments. The runner posts
 * them itself AFTER PR creation, since the PR doesn't exist yet at the point
 * fanout runs (deep-review block, before the push/PR phase). Callers receive
 * `allRuns` and can pass non-agentic runs to `postFanoutCommentsToPR` once
 * `prNumber` is known.
 */
export async function runReviewProviders(
  ctx: ReviewContext,
  opts: RunReviewProvidersOpts,
): Promise<RunReviewProvidersResult> {
  const providers = getEnabledProviders(opts.env);
  const allRuns: ReviewModelRun[] = [];

  // BEC-178 follow-up: low-yield review-model health check. Advisory only —
  // emit a warn + audit event for models below threshold; operator removes
  // from REVIEW_MODELS manually. Auto-suspend deliberately scoped out
  // (transient outage feedback-loop risk).
  const modelIds = (opts.env.REVIEW_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const healthThreshold = parseFloatOr(process.env.REVIEW_MODELS_MIN_OUTPUT_RATIO, 0.05);
  const healthLookbackHours = parseIntOr(process.env.REVIEW_MODELS_HEALTH_LOOKBACK_HOURS, 168);
  const healthMinRuns = parseIntOr(process.env.REVIEW_MODELS_MIN_RUNS, 5);

  try {
    const scores = await getModelHealthScores(opts.db, {
      lookbackHours: healthLookbackHours,
      minRuns: healthMinRuns,
    });
    const flagged = flagLowYieldModels(scores, modelIds, {
      threshold: healthThreshold,
      minRuns: healthMinRuns,
    });
    for (const modelId of flagged) {
      const s = scores.get(modelId)!;
      log.warn(
        { modelId, outputRatio: s.outputRatio, runs: s.runs, threshold: healthThreshold },
        `review model below output-ratio threshold — consider removing from REVIEW_MODELS`,
      );
      void logAuditEventUnchecked(
        opts.db,
        reviewModelLowOutputRatioEvent({
          modelId,
          outputRatio: s.outputRatio,
          runs: s.runs,
          threshold: healthThreshold,
        }),
      );
    }
  } catch (err) {
    log.warn({ err }, "model-health probe failed — skipping flagging this tick");
  }

  for (const p of providers) {
    try {
      const runs = await p.runReview(ctx);
      allRuns.push(...runs);
    } catch (err) {
      log.warn(
        { providerId: p.id, err: err instanceof Error ? err.message : String(err) },
        "review provider threw — recording as advisory failure",
      );
      allRuns.push({
        modelId: p.id,
        providerId: p.id,
        status: "failed",
        findings: [],
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (ctx.stageRunId) {
    try {
      await insertReviewModelRuns(opts.db, ctx.stageRunId, allRuns);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "insertReviewModelRuns failed — continuing",
      );
    }
  } else {
    log.warn(
      "runReviewProviders called without stageRunId; skipping per-model persistence",
    );
  }

  const agenticFindings = allRuns
    .filter((r) => r.providerId === "agentic")
    .flatMap((r) => r.findings);

  return {
    agenticFindings,
    totalInputTokens: allRuns.reduce((s, r) => s + r.inputTokens, 0),
    totalOutputTokens: allRuns.reduce((s, r) => s + r.outputTokens, 0),
    allRuns,
  };
}
