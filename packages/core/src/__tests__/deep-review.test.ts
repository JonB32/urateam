import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deepFindingsToReviewFindings,
  buildDeepReviewContext,
  filterReuseFiles,
  filterQualityFiles,
  filterEfficiencyFiles,
  type DeepReviewFinding,
} from "../executor/deep-review.js";
import type { HandoffArtifact } from "../types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseHandoff: HandoffArtifact = {
  runId: "run-1",
  issueId: "ISS-42",
  stage: "implement",
  timestamp: "2026-04-01T00:00:00Z",
  summary: "Added user search endpoint",
  filesChanged: ["src/search.ts", "src/search.test.ts"],
  approach: "New GET /search endpoint using existing service",
  context: {
    issueIntent: "Add user search",
    constraints: ["Must use existing user service"],
    assumptions: ["Case-insensitive"],
  },
  tokenBudget: { contextTokensUsed: 10000, recommendedMaxTurns: 15 },
};

const sampleFindings: DeepReviewFinding[] = [
  {
    agent: "reuse",
    severity: "warning",
    file: "src/search.ts",
    line: 12,
    category: "duplicate-logic",
    description: "Filter logic duplicates utils/filter.ts#filterUsers",
    fix: "Import and call filterUsers from utils/filter.ts",
  },
  {
    agent: "quality",
    severity: "blocking",
    file: "src/search.ts",
    line: 25,
    category: "stringly-typed",
    description: "Magic string 'active' used for status filter",
    fix: "Extract UserStatus enum with ACTIVE constant",
  },
  {
    agent: "efficiency",
    severity: "suggestion",
    file: "src/search.ts",
    line: 40,
    category: "sequential-await",
    description: "Two independent DB queries awaited sequentially",
    fix: "Wrap in Promise.all to run concurrently",
  },
];

// ---------------------------------------------------------------------------
// deepFindingsToReviewFindings
// ---------------------------------------------------------------------------

describe("deepFindingsToReviewFindings", () => {
  it("converts deep findings to ReviewFindings", () => {
    const result = deepFindingsToReviewFindings(sampleFindings);
    expect(result).toHaveLength(3);
  });

  it("preserves severity from deep finding", () => {
    const result = deepFindingsToReviewFindings(sampleFindings);
    expect(result[0].severity).toBe("warning");
    expect(result[1].severity).toBe("blocking");
    expect(result[2].severity).toBe("suggestion");
  });

  it("prefixes category with agent name", () => {
    const result = deepFindingsToReviewFindings(sampleFindings);
    expect(result[0].category).toBe("reuse:duplicate-logic");
    expect(result[1].category).toBe("quality:stringly-typed");
    expect(result[2].category).toBe("efficiency:sequential-await");
  });

  it("preserves file, line, description, fix", () => {
    const result = deepFindingsToReviewFindings([sampleFindings[0]]);
    expect(result[0].file).toBe("src/search.ts");
    expect(result[0].line).toBe(12);
    expect(result[0].description).toBe(sampleFindings[0].description);
    expect(result[0].fix).toBe(sampleFindings[0].fix);
  });

  it("returns empty array for empty input", () => {
    expect(deepFindingsToReviewFindings([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDeepReviewContext
// ---------------------------------------------------------------------------

describe("buildDeepReviewContext", () => {
  it("includes the pass number", () => {
    const ctx = buildDeepReviewContext(2, sampleFindings, baseHandoff);
    expect(ctx).toContain('pass="2"');
    expect(ctx).toContain("deep-review pass 2");
  });

  it("includes all three agent sections", () => {
    const ctx = buildDeepReviewContext(1, sampleFindings, baseHandoff);
    expect(ctx).toContain("Code Reuse findings:");
    expect(ctx).toContain("Code Quality findings:");
    expect(ctx).toContain("Efficiency findings:");
  });

  it("includes finding descriptions in the context", () => {
    const ctx = buildDeepReviewContext(1, sampleFindings, baseHandoff);
    expect(ctx).toContain("Filter logic duplicates");
    expect(ctx).toContain("Magic string");
    expect(ctx).toContain("independent DB queries");
  });

  it("includes previous handoff summary", () => {
    const ctx = buildDeepReviewContext(1, sampleFindings, baseHandoff);
    expect(ctx).toContain("Added user search endpoint");
  });

  it("shows (none) for empty agent sections", () => {
    const reuseOnly: DeepReviewFinding[] = [sampleFindings[0]];
    const ctx = buildDeepReviewContext(1, reuseOnly, baseHandoff);
    expect(ctx).toContain("Code Quality findings:\n  (none)");
    expect(ctx).toContain("Efficiency findings:\n  (none)");
  });

  it("includes severity tag in each finding line", () => {
    const ctx = buildDeepReviewContext(1, sampleFindings, baseHandoff);
    expect(ctx).toContain("[warning]");
    expect(ctx).toContain("[blocking]");
    expect(ctx).toContain("[suggestion]");
  });

  it("produces non-empty context for empty findings array", () => {
    const ctx = buildDeepReviewContext(1, [], baseHandoff);
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx).toContain("(none)");
  });
});

// ---------------------------------------------------------------------------
// PipelineConfigSchema — new deep review fields
// ---------------------------------------------------------------------------

describe("PipelineConfigSchema — deep review config", () => {
  it("accepts deepReviewPasses and maxDeepReviewPasses", async () => {
    const { PipelineConfigSchema } = await import("../types.js");
    const result = PipelineConfigSchema.safeParse({
      name: "Full",
      stages: ["implement", "test", "review"],
      retry: { maxAttempts: 2, strategy: "fix-and-retry" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
      deepReviewPasses: 2,
      maxDeepReviewPasses: 5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deepReviewPasses).toBe(2);
      expect(result.data.maxDeepReviewPasses).toBe(5);
    }
  });

  it("defaults deepReviewPasses and maxDeepReviewPasses to undefined (optional)", async () => {
    const { PipelineConfigSchema } = await import("../types.js");
    const result = PipelineConfigSchema.safeParse({
      name: "Minimal",
      stages: ["implement"],
      retry: { maxAttempts: 0, strategy: "fail-fast" },
      review: { requiredApprovals: 0 },
      prStrategy: "ready",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deepReviewPasses).toBeUndefined();
      expect(result.data.maxDeepReviewPasses).toBeUndefined();
    }
  });

  it("rejects deepReviewPasses above 5", async () => {
    const { PipelineConfigSchema } = await import("../types.js");
    const result = PipelineConfigSchema.safeParse({
      name: "Bad",
      stages: ["implement", "review"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
      deepReviewPasses: 6,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxDeepReviewPasses of 0", async () => {
    const { PipelineConfigSchema } = await import("../types.js");
    const result = PipelineConfigSchema.safeParse({
      name: "Bad",
      stages: ["implement", "review"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
      maxDeepReviewPasses: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxDeepReviewPasses above 10", async () => {
    const { PipelineConfigSchema } = await import("../types.js");
    const result = PipelineConfigSchema.safeParse({
      name: "Bad",
      stages: ["implement", "review"],
      retry: { maxAttempts: 1, strategy: "fail-fast" },
      review: { requiredApprovals: 1 },
      prStrategy: "draft",
      maxDeepReviewPasses: 11,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File subset filters
// ---------------------------------------------------------------------------

const MIXED_FILES = [
  "src/user.ts",
  "src/user.test.ts",
  "src/user.spec.ts",
  "__tests__/helpers.ts",
  "tests/integration.ts",
  "dist/bundle.js",
  "build/output.js",
  "src/types.d.ts",
  "generated/schema.ts",
  "tsconfig.json",
  "package.json",
  ".eslintrc.js",
  "src/server.config.ts",
  "README.md",
  "docs/setup.md",
  "src/logo.png",
  "src/styles.css",
  "src/index.html",
  "src/api.ts",
  "src/db/client.ts",
];

describe("filterReuseFiles", () => {
  it("keeps source files", () => {
    const result = filterReuseFiles(MIXED_FILES);
    expect(result).toContain("src/user.ts");
    expect(result).toContain("src/api.ts");
    expect(result).toContain("src/db/client.ts");
  });

  it("excludes test files", () => {
    const result = filterReuseFiles(MIXED_FILES);
    expect(result).not.toContain("src/user.test.ts");
    expect(result).not.toContain("src/user.spec.ts");
    expect(result).not.toContain("__tests__/helpers.ts");
    expect(result).not.toContain("tests/integration.ts");
  });

  it("excludes config files", () => {
    const result = filterReuseFiles(MIXED_FILES);
    expect(result).not.toContain("tsconfig.json");
    expect(result).not.toContain("package.json");
    expect(result).not.toContain(".eslintrc.js");
    expect(result).not.toContain("src/server.config.ts");
  });

  it("excludes doc files", () => {
    const result = filterReuseFiles(MIXED_FILES);
    expect(result).not.toContain("README.md");
    expect(result).not.toContain("docs/setup.md");
  });

  it("excludes generated/dist files", () => {
    const result = filterReuseFiles(MIXED_FILES);
    expect(result).not.toContain("dist/bundle.js");
    expect(result).not.toContain("build/output.js");
    expect(result).not.toContain("src/types.d.ts");
    expect(result).not.toContain("generated/schema.ts");
  });

  it("excludes static assets", () => {
    const result = filterReuseFiles(MIXED_FILES);
    expect(result).not.toContain("src/logo.png");
    expect(result).not.toContain("src/styles.css");
    expect(result).not.toContain("src/index.html");
  });

  it("returns empty array when no source files present", () => {
    expect(filterReuseFiles(["README.md", "dist/out.js"])).toEqual([]);
  });
});

describe("filterQualityFiles", () => {
  it("keeps source and test files", () => {
    const result = filterQualityFiles(MIXED_FILES);
    expect(result).toContain("src/user.ts");
    expect(result).toContain("src/user.test.ts");
    expect(result).toContain("src/api.ts");
  });

  it("excludes generated/dist files only", () => {
    const result = filterQualityFiles(MIXED_FILES);
    expect(result).not.toContain("dist/bundle.js");
    expect(result).not.toContain("build/output.js");
    expect(result).not.toContain("src/types.d.ts");
    expect(result).not.toContain("generated/schema.ts");
  });

  it("keeps config files", () => {
    const result = filterQualityFiles(MIXED_FILES);
    expect(result).toContain("tsconfig.json");
    expect(result).toContain("package.json");
  });

  it("returns empty array when only generated files present", () => {
    expect(filterQualityFiles(["dist/a.js", "build/b.js", "src/c.d.ts"])).toEqual([]);
  });
});

describe("filterEfficiencyFiles", () => {
  it("keeps source files", () => {
    const result = filterEfficiencyFiles(MIXED_FILES);
    expect(result).toContain("src/user.ts");
    expect(result).toContain("src/api.ts");
    expect(result).toContain("src/db/client.ts");
  });

  it("excludes test files", () => {
    const result = filterEfficiencyFiles(MIXED_FILES);
    expect(result).not.toContain("src/user.test.ts");
    expect(result).not.toContain("src/user.spec.ts");
    expect(result).not.toContain("__tests__/helpers.ts");
  });

  it("excludes static assets", () => {
    const result = filterEfficiencyFiles(MIXED_FILES);
    expect(result).not.toContain("src/logo.png");
    expect(result).not.toContain("src/styles.css");
    expect(result).not.toContain("src/index.html");
  });

  it("excludes generated/dist files", () => {
    const result = filterEfficiencyFiles(MIXED_FILES);
    expect(result).not.toContain("dist/bundle.js");
    expect(result).not.toContain("build/output.js");
    expect(result).not.toContain("generated/schema.ts");
  });

  it("keeps config and doc files (not excluded by efficiency filter)", () => {
    const result = filterEfficiencyFiles(MIXED_FILES);
    expect(result).toContain("tsconfig.json");
    expect(result).toContain("README.md");
  });

  it("returns empty array when only test/asset files present", () => {
    expect(filterEfficiencyFiles(["src/x.test.ts", "src/y.png"])).toEqual([]);
  });
});
