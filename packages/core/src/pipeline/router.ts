import type { PipelineConfig } from "../types.js";

// Priority order: quick-fix > bug > auto-implement > needs-design
const LABEL_PRIORITY = ["quick-fix", "bug", "auto-implement", "needs-design"];

export function resolvePipeline(
  labels: string[],
  configs: Record<string, PipelineConfig>
): { key: string; config: PipelineConfig } | null {
  const lower = labels.map((l) => l.toLowerCase());
  // Check labels in priority order
  for (const label of LABEL_PRIORITY) {
    if (lower.includes(label) && configs[label]) {
      return { key: label, config: configs[label] };
    }
  }
  // Fall back to first matching label
  for (const lbl of lower) {
    if (configs[lbl]) {
      return { key: lbl, config: configs[lbl] };
    }
  }
  return null;
}
