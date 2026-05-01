import type { HandoffArtifact, ReviewFinding } from "../../types.js";
import { AgenticDeepReviewProvider } from "./agentic-deep-review.js";

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

export function getEnabledProviders(_env: NodeJS.ProcessEnv): ReviewProvider[] {
  return [new AgenticDeepReviewProvider()];
}
