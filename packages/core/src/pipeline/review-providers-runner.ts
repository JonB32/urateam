import type { Octokit } from "@octokit/rest";
import {
  getEnabledProviders,
  type ReviewContext,
  type ReviewModelRun,
} from "../executor/review/review-provider.js";
import { insertReviewModelRuns } from "../db/review-model-runs.js";
import type { AnyDb } from "../db/client.js";
import { postFanoutCommentsToPR } from "../executor/review/post-fanout-comments.js";
import type { ReviewFinding } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "ReviewProvidersRunner" });

export interface RunReviewProvidersOpts {
  env: NodeJS.ProcessEnv;
  db: AnyDb;
  octokit: Octokit;
  owner: string;
  repo: string;
}

export interface RunReviewProvidersResult {
  agenticFindings: ReviewFinding[];
  totalInputTokens: number;
  totalOutputTokens: number;
  allRuns: ReviewModelRun[];
}

/**
 * Runs all enabled review providers in sequence, persists their per-model
 * results to `review_model_runs`, and (when a PR exists) posts a fanout
 * advisory comment per non-agentic run.
 *
 * Provider failures are caught and recorded as advisory `failed` runs rather
 * than rethrown, so a flaky third-party model can never fail the pipeline.
 *
 * Persistence and comment-posting are skipped when `ctx.stageRunId === ""`
 * (the runner does not always have a stage_run row to associate the rows
 * with — see runner.ts comment near the deep-review loop).
 */
export async function runReviewProviders(
  ctx: ReviewContext,
  opts: RunReviewProvidersOpts,
): Promise<RunReviewProvidersResult> {
  const providers = getEnabledProviders(opts.env);
  const allRuns: ReviewModelRun[] = [];

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

  const fanoutRuns = allRuns.filter((r) => r.providerId !== "agentic");
  if (ctx.prNumber !== null && fanoutRuns.length > 0) {
    try {
      await postFanoutCommentsToPR(opts.octokit, opts.owner, opts.repo, ctx.prNumber, fanoutRuns);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "post-fanout-comments failed — continuing",
      );
    }
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
