export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface RunCost {
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
}

export interface CostSummary {
  window: { from: Date; to: Date };
  runs: number;
  prsMerged: number;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
  roiMultiplier: number;
  /** Set when the underlying query exceeded the row cap and was truncated. */
  truncated?: boolean;
}

export type BreakdownDimension = "team" | "repo" | "pipeline";

export interface BreakdownRow {
  key: string;
  label: string;
  runs: number;
  prsMerged: number;
  inputTokens: number;
  outputTokens: number;
  dollars: number;
  timeSavedHours: number;
  roiMultiplier: number;
}

export interface AggregateResult {
  summary: CostSummary;
  byTeam: BreakdownRow[];
  byRepo: BreakdownRow[];
  byPipeline: BreakdownRow[];
}
