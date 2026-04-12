import { describe, it, expect } from "vitest";
import {
  defaultConfigs,
  validatePipelineConfigs,
  validateRepoConfigs,
  resolvePipeline,
} from "../pipeline/index.js";
import type { StageType } from "../types.js";

// ── Shared test fixtures ──────────────────────────────────────────────────────

const BASE_STAGES = ["implement", "test"] as const;
const BASE_RETRY = { maxAttempts: 1, strategy: "escalate" } as const;
const BASE_REVIEW = { requiredApprovals: 0 } as const;
const BASE_PR_STRATEGY = "draft" as const;

const baseCustomConfig = {
  name: "Custom",
  stages: [...BASE_STAGES],
  retry: { ...BASE_RETRY },
  review: { ...BASE_REVIEW },
  prStrategy: BASE_PR_STRATEGY,
} as const;

// ── defaultConfigs ────────────────────────────────────────────────────────────

describe("defaultConfigs", () => {
  it("has all 4 pipeline configs", () => {
    expect(Object.keys(defaultConfigs)).toHaveLength(4);
    expect(defaultConfigs["auto-implement"]).toBeDefined();
    expect(defaultConfigs["bug"]).toBeDefined();
    expect(defaultConfigs["needs-design"]).toBeDefined();
    expect(defaultConfigs["quick-fix"]).toBeDefined();
  });

  it("all default configs pass validation", () => {
    const result = validatePipelineConfigs(defaultConfigs);
    expect(Object.keys(result)).toHaveLength(4);
  });

  it.each([
    ["ralphIterations", 2],
    ["reviewFixIterations", 1],
    ["deepReviewPasses", 0],
    ["validateHandoffs", false],
  ] as const)(
    'every default config has %s: %p',
    (prop, expected) => {
      for (const key of Object.keys(defaultConfigs)) {
        expect(defaultConfigs[key][prop]).toBe(expected);
      }
    }
  );
});

// ── defaultConfigs loop default overrides ────────────────────────────────────

describe("defaultConfigs loop default overrides", () => {
  it.each([
    ["ralphIterations", 3],
    ["reviewFixIterations", 4],
    ["deepReviewPasses", 2],
    ["validateHandoffs", true],
  ] as const)(
    "explicit %s in a pipeline config overrides the default",
    (field, value) => {
      const configs = {
        custom: { ...baseCustomConfig, [field]: value },
      };
      const result = validatePipelineConfigs(configs);
      expect(result.custom[field]).toBe(value);
    }
  );
});

// ── validatePipelineConfigs ───────────────────────────────────────────────────

describe("validatePipelineConfigs", () => {
  it("accepts valid configs", () => {
    const configs = { custom: { ...baseCustomConfig } };
    const result = validatePipelineConfigs(configs);
    expect(result.custom.name).toBe("Custom");
  });

  it("throws for invalid stage names", () => {
    const configs = {
      bad: {
        name: "Bad",
        stages: ["invalid-stage"],
        retry: { ...BASE_RETRY },
        review: { ...BASE_REVIEW },
        prStrategy: BASE_PR_STRATEGY,
      },
    };
    expect(() => validatePipelineConfigs(configs)).toThrow(
      'Invalid pipeline config "bad"'
    );
  });

  it("throws for invalid retry strategy", () => {
    const configs = {
      bad: {
        name: "Bad",
        stages: ["implement"],
        retry: { maxAttempts: 1, strategy: "invalid-strategy" },
        review: { ...BASE_REVIEW },
        prStrategy: BASE_PR_STRATEGY,
      },
    };
    expect(() => validatePipelineConfigs(configs)).toThrow(
      'Invalid pipeline config "bad"'
    );
  });
});

// ── validateRepoConfigs ───────────────────────────────────────────────────────

describe("validateRepoConfigs", () => {
  it("accepts valid repo configs", () => {
    const configs = {
      myrepo: {
        url: "https://github.com/org/repo",
        defaultBranch: "main",
        testCommand: "npm test",
        buildCommand: "npm run build",
      },
    };
    const result = validateRepoConfigs(configs);
    expect(result.myrepo.url).toBe("https://github.com/org/repo");
  });

  it("throws for missing required fields", () => {
    const configs = {
      bad: {
        url: "https://github.com/org/repo",
        // missing defaultBranch, testCommand, buildCommand
      },
    };
    expect(() => validateRepoConfigs(configs)).toThrow(
      'Invalid repo config "bad"'
    );
  });
});

// ── resolvePipeline ───────────────────────────────────────────────────────────

describe("resolvePipeline", () => {
  it("picks quick-fix over bug when both present", () => {
    const result = resolvePipeline(["bug", "quick-fix"], defaultConfigs);
    expect(result).not.toBeNull();
    expect(result!.key).toBe("quick-fix");
  });

  it("picks bug over auto-implement", () => {
    const result = resolvePipeline(
      ["auto-implement", "bug"],
      defaultConfigs
    );
    expect(result).not.toBeNull();
    expect(result!.key).toBe("bug");
  });

  it("returns null when no labels match", () => {
    const result = resolvePipeline(["unrelated", "labels"], defaultConfigs);
    expect(result).toBeNull();
  });

  it("handles custom/non-priority labels", () => {
    const customConfigs = {
      ...defaultConfigs,
      "custom-pipeline": {
        name: "Custom",
        stages: ["implement", "test"] as StageType[],
        retry: { maxAttempts: 1, strategy: "escalate" as const },
        review: { requiredApprovals: 0 },
        prStrategy: "draft" as const,
      },
    };
    const result = resolvePipeline(["custom-pipeline"], customConfigs);
    expect(result).not.toBeNull();
    expect(result!.key).toBe("custom-pipeline");
    expect(result!.config.name).toBe("Custom");
  });
});
