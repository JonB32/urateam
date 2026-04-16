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

export interface DailyRow {
  /** UTC date, formatted YYYY-MM-DD. */
  date: string;
  runs: number;
  prsMerged: number;
  dollars: number;
  timeSavedHours: number;
}

export interface AggregateResult {
  summary: CostSummary;
  byTeam: BreakdownRow[];
  byRepo: BreakdownRow[];
  byPipeline: BreakdownRow[];
  /** Per-UTC-day time series sorted ascending by date. Used for sparkline rendering. */
  byDay: DailyRow[];
}
