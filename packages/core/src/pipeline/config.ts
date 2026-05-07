import { PipelineConfigSchema, RepoConfigSchema } from "../types.js";
import type { PipelineConfig, RepoConfig } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "pipeline.config" });

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

/**
 * BEC-163: env-var override for `deepReviewPasses` so operators can enable
 * BEC-134 OpenRouter fanout without forking the built-in pipeline configs.
 *
 * Returns a new map where every pipeline whose `stages` array includes
 * `"review"` has its `deepReviewPasses` set to the parsed env value.
 * Pipelines without a `review` stage are passed through untouched (the
 * fanout has nothing to attach to and the cost would be wasted).
 *
 * `envValue === undefined` → returns the input unchanged.
 * Invalid input (non-integer, negative) → logs warn, returns input unchanged.
 */
export function applyDeepReviewPassesOverride(
  configs: Record<string, PipelineConfig>,
  envValue: string | undefined,
): Record<string, PipelineConfig> {
  if (envValue === undefined) return configs;
  const n = parseInt(envValue, 10);
  if (Number.isNaN(n) || n < 0 || envValue.trim() === "") {
    log.warn(
      { envValue, var: "URATEAM_DEEP_REVIEW_PASSES" },
      "URATEAM_DEEP_REVIEW_PASSES must be a non-negative integer — ignoring",
    );
    return configs;
  }
  const result: Record<string, PipelineConfig> = {};
  for (const [key, cfg] of Object.entries(configs)) {
    if ((cfg.stages ?? []).includes("review")) {
      result[key] = { ...cfg, deepReviewPasses: n };
    } else {
      result[key] = cfg;
    }
  }
  return result;
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
