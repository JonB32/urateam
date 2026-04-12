import { PipelineConfigSchema, RepoConfigSchema } from "../types.js";
import type { PipelineConfig, RepoConfig } from "../types.js";

// Shared reduced-cost loop defaults applied to every built-in pipeline.
// These can be overridden per-pipeline in your own config by setting explicit values.
// To opt in to the previous (higher) values, set e.g. ralphIterations: 2 in your config.
const LOOP_DEFAULTS = {
  ralphIterations: 2,       // RALPH gate: verify acceptance criteria after implement, retry once if gaps found
  reviewFixIterations: 1,   // single review-fix pass catches most blocking issues
  deepReviewPasses: 0,      // disabled by default; opt-in for critical pipelines
  validateHandoffs: false,  // disabled by default; opt-in per pipeline
} as const;

// Default pipeline configs from the spec
export const defaultConfigs: Record<string, PipelineConfig> = {
  "auto-implement": {
    ...LOOP_DEFAULTS,
    name: "Auto Implement",
    stages: ["implement", "test", "review"],
    retry: { maxAttempts: 2, strategy: "fix-and-retry" },
    review: { requiredApprovals: 1 },
    prStrategy: "draft",
  },
  "bug": {
    ...LOOP_DEFAULTS,
    name: "Bug Fix",
    stages: ["reproduce", "implement", "test", "review"],
    retry: { maxAttempts: 3, strategy: "fix-and-retry" },
    review: { requiredApprovals: 1 },
    prStrategy: "draft",
  },
  "needs-design": {
    ...LOOP_DEFAULTS,
    name: "Needs Design",
    stages: ["triage", "await-approval", "implement", "test", "review"],
    retry: { maxAttempts: 1, strategy: "fail-fast" },
    review: { requiredApprovals: 1 },
    prStrategy: "draft",
  },
  "quick-fix": {
    ...LOOP_DEFAULTS,
    name: "Quick Fix",
    stages: ["implement", "test"],
    retry: { maxAttempts: 1, strategy: "escalate" },
    review: { requiredApprovals: 0 },
    prStrategy: "ready",
  },
};

export function validatePipelineConfigs(
  configs: Record<string, unknown>
): Record<string, PipelineConfig> {
  const validated: Record<string, PipelineConfig> = {};
  for (const [key, value] of Object.entries(configs)) {
    const result = PipelineConfigSchema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `Invalid pipeline config "${key}": ${result.error.issues.map((i) => i.message).join(", ")}`
      );
    }
    validated[key] = result.data;
  }
  return validated;
}

export function validateRepoConfigs(
  configs: Record<string, unknown>
): Record<string, RepoConfig> {
  const validated: Record<string, RepoConfig> = {};
  for (const [key, value] of Object.entries(configs)) {
    const result = RepoConfigSchema.safeParse(value);
    if (!result.success) {
      throw new Error(
        `Invalid repo config "${key}": ${result.error.issues.map((i) => i.message).join(", ")}`
      );
    }
    validated[key] = result.data;
  }
  return validated;
}
