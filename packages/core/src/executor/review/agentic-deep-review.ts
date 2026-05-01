import { runDeepReview, deepFindingsToReviewFindings } from "../deep-review.js";
import type { ReviewProvider, ReviewModelRun, ReviewContext } from "./review-provider.js";

const DEEP_REVIEW_MODEL = "claude-haiku-4-5-20251001";

export class AgenticDeepReviewProvider implements ReviewProvider {
  readonly id = "agentic" as const;

  async runReview(ctx: ReviewContext): Promise<ReviewModelRun[]> {
    const startedAt = Date.now();
    try {
      const result = await runDeepReview(ctx.handoff, ctx.workdir);
      return [
        {
          modelId: DEEP_REVIEW_MODEL,
          providerId: "agentic",
          status: "completed",
          findings: deepFindingsToReviewFindings(result.findings),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: Date.now() - startedAt,
        },
      ];
    } catch (err) {
      return [
        {
          modelId: DEEP_REVIEW_MODEL,
          providerId: "agentic",
          status: "failed",
          findings: [],
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - startedAt,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      ];
    }
  }
}
