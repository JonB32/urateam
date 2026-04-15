export interface PolicyViolation {
  gate: "path" | "cost" | "reviewer";
  detail: string;
  severity: "blocking";
  payload: Record<string, unknown>;
}
