import type { HandoffArtifact, ReviewFinding } from "../../types.js";

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
}

export interface ReviewProvider {
  readonly id: ReviewProviderId;
  runReview(ctx: ReviewContext): Promise<ReviewModelRun[]>;
}

// Stub registry — Task 7 fills in real selection logic.
// For now, returns only a placeholder that satisfies the interface, so callers
// in later tasks can typecheck. AgenticDeepReviewProvider arrives in Task 2;
// we wire it in here at that point.
const placeholderAgentic: ReviewProvider = {
  id: "agentic",
  async runReview(_ctx) {
    return [];
  },
};

export function getEnabledProviders(_env: NodeJS.ProcessEnv): ReviewProvider[] {
  return [placeholderAgentic];
}
