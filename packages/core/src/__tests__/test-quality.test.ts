import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mock fs/promises so we never touch disk
// ---------------------------------------------------------------------------
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import {
  isTestFile,
  extractTestBlocks,
  analyzeTestFile,
  checkTestQuality,
  TRIVIAL_MATCHERS,
  BEHAVIORAL_MATCHERS,
  TRIVIAL_THRESHOLD,
} from "../executor/test-quality.js";

// ---------------------------------------------------------------------------
// Helper: configure readFile mock for a given path → content mapping
// ---------------------------------------------------------------------------
function mockReadFile(fileMap: Record<string, string>) {
  (readFile as ReturnType<typeof vi.fn>).mockImplementation(
    async (path: string) => {
      const content = fileMap[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------
describe("isTestFile", () => {
  it("recognises .test.ts files", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
  });

  it("recognises .spec.js files", () => {
    expect(isTestFile("lib/bar.spec.js")).toBe(true);
  });

  it("recognises files inside __tests__ directories", () => {
    expect(isTestFile("src/__tests__/baz.ts")).toBe(true);
  });

  it("rejects regular source files", () => {
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isTestFile("lib/bar.js")).toBe(false);
  });

  it("rejects files that merely contain 'test' in a directory name", () => {
    expect(isTestFile("src/testUtils/helpers.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TRIVIAL_MATCHERS / BEHAVIORAL_MATCHERS sanity checks
// ---------------------------------------------------------------------------
describe("assertion classification constants", () => {
  it("TRIVIAL_MATCHERS includes the expected trivial matchers", () => {
    expect(TRIVIAL_MATCHERS).toContain("toBeDefined");
    expect(TRIVIAL_MATCHERS).toContain("toBeTruthy");
    expect(TRIVIAL_MATCHERS).toContain("toBeFalsy");
    expect(TRIVIAL_MATCHERS).toContain("toBeNull");
    expect(TRIVIAL_MATCHERS).toContain("toBeUndefined");
  });

  it("BEHAVIORAL_MATCHERS includes the expected behavioral matchers", () => {
    expect(BEHAVIORAL_MATCHERS).toContain("toEqual");
    expect(BEHAVIORAL_MATCHERS).toContain("toContain");
    expect(BEHAVIORAL_MATCHERS).toContain("toHaveBeenCalledWith");
    expect(BEHAVIORAL_MATCHERS).toContain("toMatch");
    expect(BEHAVIORAL_MATCHERS).toContain("toThrow");
    expect(BEHAVIORAL_MATCHERS).toContain("toHaveLength");
  });

  it("TRIVIAL_THRESHOLD is 0.8", () => {
    expect(TRIVIAL_THRESHOLD).toBe(0.8);
  });

  it("TRIVIAL_MATCHERS and BEHAVIORAL_MATCHERS have no overlap", () => {
    const trivialSet = new Set(TRIVIAL_MATCHERS);
    const behavioral = BEHAVIORAL_MATCHERS as readonly string[];
    for (const m of behavioral) {
      expect(trivialSet.has(m as any)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// extractTestBlocks
// ---------------------------------------------------------------------------
describe("extractTestBlocks", () => {
  it("extracts a single test block by name", () => {
    const content = `
it("adds two numbers", async () => {
  expect(add(1, 2)).toEqual(3);
});
`;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("adds two numbers");
    expect(blocks[0].content).toContain("toEqual");
  });

  it("extracts multiple test blocks", () => {
    const content = `
it("first test", () => {
  expect(a).toBeDefined();
});
it("second test", () => {
  expect(b).toEqual(42);
});
`;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].name).toBe("first test");
    expect(blocks[1].name).toBe("second test");
  });

  it("supports test() in addition to it()", () => {
    const content = `
test("it works", () => {
  expect(x).toBe(true);
});
`;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe("it works");
  });

  it("returns empty array for content with no test blocks", () => {
    const blocks = extractTestBlocks("const x = 1;");
    expect(blocks).toHaveLength(0);
  });

  it("handles backtick-quoted test names", () => {
    const content = "it(`dynamic ${name}`, () => { expect(x).toEqual(1); });";
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toContain("dynamic");
  });
});

// ---------------------------------------------------------------------------
// analyzeTestFile — trivial-only file (BEC-52 dashboard pattern)
// ---------------------------------------------------------------------------
describe("analyzeTestFile — trivial-only assertions (BEC-52 pattern)", () => {
  it("flags a file where all assertions are toBeDefined", async () => {
    const content = `
import { describe, it, expect } from "vitest";
describe("server", () => {
  it("renders", () => { expect(app).toBeDefined(); });
  it("has routes", () => { expect(router).toBeDefined(); });
  it("starts", () => { expect(app).toBeDefined(); });
});
`;
    mockReadFile({ "/worktree/server.test.ts": content });

    const analysis = await analyzeTestFile("/worktree/server.test.ts");

    expect(analysis.isFlagged).toBe(true);
    expect(analysis.trivialAssertions).toBe(3);
    expect(analysis.behavioralAssertions).toBe(0);
    expect(analysis.trivialRatio).toBe(1);
    expect(analysis.testsWithoutBehavioralAssertion).toHaveLength(3);
  });

  it("flags a file where >80% assertions are trivial", async () => {
    const content = `
it("a", () => { expect(x).toBeDefined(); expect(y).toBeDefined(); expect(z).toBeDefined(); expect(w).toBeDefined(); });
it("b", () => { expect(result).toEqual(42); });
`;
    // 4 trivial + 1 behavioral = 5 total → 80% trivial (exactly at threshold, should NOT flag)
    mockReadFile({ "/worktree/mixed.test.ts": content });
    const analysis = await analyzeTestFile("/worktree/mixed.test.ts");
    // ratio = 4/5 = 0.8 — exactly at threshold so NOT flagged (> not >=)
    expect(analysis.trivialRatio).toBe(0.8);
    expect(analysis.isFlagged).toBe(false);
  });

  it("flags a file where 5 of 6 assertions are trivial (>80%)", async () => {
    const content = `
it("a", () => {
  expect(x).toBeDefined();
  expect(y).toBeDefined();
  expect(z).toBeDefined();
  expect(w).toBeDefined();
  expect(v).toBeDefined();
  expect(result).toEqual(42);
});
`;
    // 5/6 ≈ 83.3% trivial → should flag
    mockReadFile({ "/worktree/mostly-trivial.test.ts": content });
    const analysis = await analyzeTestFile("/worktree/mostly-trivial.test.ts");
    expect(analysis.trivialRatio).toBeGreaterThan(TRIVIAL_THRESHOLD);
    expect(analysis.isFlagged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// analyzeTestFile — behavioral assertions (good tests)
// ---------------------------------------------------------------------------
describe("analyzeTestFile — behavioral assertions", () => {
  it("does not flag a file with mostly behavioral assertions", async () => {
    const content = `
it("returns sum", () => {
  expect(add(1, 2)).toEqual(3);
  expect(add(0, 0)).toBe(0);
});
it("throws on bad input", () => {
  expect(() => add("a", 1)).toThrow();
});
`;
    mockReadFile({ "/worktree/good.test.ts": content });
    const analysis = await analyzeTestFile("/worktree/good.test.ts");

    expect(analysis.isFlagged).toBe(false);
    expect(analysis.behavioralAssertions).toBeGreaterThan(0);
    expect(analysis.testsWithoutBehavioralAssertion).toHaveLength(0);
  });

  it("counts toHaveBeenCalledWith as behavioral", async () => {
    const content = `
it("calls handler", () => {
  handler.call(payload);
  expect(handler).toHaveBeenCalledWith(payload);
});
`;
    mockReadFile({ "/worktree/spy.test.ts": content });
    const analysis = await analyzeTestFile("/worktree/spy.test.ts");

    expect(analysis.behavioralAssertions).toBe(1);
    expect(analysis.trivialAssertions).toBe(0);
    expect(analysis.isFlagged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeTestFile — per-test-function check
// ---------------------------------------------------------------------------
describe("analyzeTestFile — per-test-function analysis", () => {
  it("identifies test functions with no behavioral assertion", async () => {
    const content = `
it("loads module", () => { expect(mod).toBeDefined(); });
it("returns correct value", () => { expect(fn()).toEqual(42); });
it("is truthy", () => { expect(something).toBeTruthy(); });
`;
    mockReadFile({ "/worktree/mixed-per-test.test.ts": content });
    const analysis = await analyzeTestFile("/worktree/mixed-per-test.test.ts");

    expect(analysis.testsWithoutBehavioralAssertion).toContain("loads module");
    expect(analysis.testsWithoutBehavioralAssertion).toContain("is truthy");
    expect(analysis.testsWithoutBehavioralAssertion).not.toContain("returns correct value");
  });

  it("flags file when all tests lack behavioral assertions", async () => {
    const content = `
it("a", () => { expect(x).toBeDefined(); });
it("b", () => { expect(y).toBeTruthy(); });
`;
    mockReadFile({ "/worktree/all-trivial.test.ts": content });
    const analysis = await analyzeTestFile("/worktree/all-trivial.test.ts");

    expect(analysis.isFlagged).toBe(true);
    expect(analysis.testsWithoutBehavioralAssertion).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// analyzeTestFile — error handling
// ---------------------------------------------------------------------------
describe("analyzeTestFile — error handling", () => {
  it("returns empty analysis when file cannot be read", async () => {
    (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

    const analysis = await analyzeTestFile("/nonexistent.test.ts");

    expect(analysis.isFlagged).toBe(false);
    expect(analysis.totalAssertions).toBe(0);
  });

  it("returns unflagged analysis when file has no assertions", async () => {
    mockReadFile({ "/worktree/empty.test.ts": "describe('suite', () => {});" });

    const analysis = await analyzeTestFile("/worktree/empty.test.ts");

    expect(analysis.isFlagged).toBe(false);
    expect(analysis.totalAssertions).toBe(0);
    expect(analysis.trivialRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkTestQuality — integration
// ---------------------------------------------------------------------------
describe("checkTestQuality", () => {
  it("returns empty violations when no test files in changed set", async () => {
    const result = await checkTestQuality(["src/foo.ts", "README.md"], "/worktree");
    expect(result.violations).toHaveLength(0);
    expect(result.analyses).toHaveLength(0);
  });

  it("returns violations for flagged test files", async () => {
    const trivialContent = `
it("defines app", () => { expect(app).toBeDefined(); });
it("defines router", () => { expect(router).toBeDefined(); });
it("defines handler", () => { expect(handler).toBeDefined(); });
`;
    mockReadFile({
      [join("/worktree", "src/__tests__/server.test.ts")]: trivialContent,
    });

    const result = await checkTestQuality(
      ["src/__tests__/server.test.ts"],
      "/worktree",
    );

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].severity).toBe("warning");
    expect(result.violations[0].category).toBe("Test Quality");
    expect(result.violations[0].description).toContain("trivial");
    expect(result.violations[0].fix).toContain("toEqual");
    expect(result.analyses).toHaveLength(1);
    expect(result.analyses[0].isFlagged).toBe(true);
  });

  it("does not emit violations for good test files", async () => {
    const goodContent = `
it("sums correctly", () => { expect(sum(1, 2)).toEqual(3); });
it("throws on bad input", () => { expect(() => sum(null, 2)).toThrow(); });
`;
    mockReadFile({
      [join("/worktree", "src/__tests__/sum.test.ts")]: goodContent,
    });

    const result = await checkTestQuality(
      ["src/__tests__/sum.test.ts", "src/sum.ts"],
      "/worktree",
    );

    expect(result.violations).toHaveLength(0);
    expect(result.analyses).toHaveLength(1);
    expect(result.analyses[0].isFlagged).toBe(false);
  });

  it("skips non-test files in changedFiles list", async () => {
    const result = await checkTestQuality(["src/index.ts", "package.json"], "/worktree");
    expect(result.violations).toHaveLength(0);
    expect(result.analyses).toHaveLength(0);
  });

  it("produces ReviewFinding objects compatible with the HandoffArtifact schema", async () => {
    const content = `it("trivial", () => { expect(x).toBeDefined(); });`;
    mockReadFile({ [join("/worktree", "foo.test.ts")]: content });

    const result = await checkTestQuality(["foo.test.ts"], "/worktree");

    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    // Must satisfy ReviewFinding shape
    expect(typeof v.severity).toBe("string");
    expect(["blocking", "warning", "suggestion"]).toContain(v.severity);
    expect(typeof v.file).toBe("string");
    expect(typeof v.line).toBe("number");
    expect(typeof v.category).toBe("string");
    expect(typeof v.description).toBe("string");
    expect(typeof v.fix).toBe("string");
  });

  // ---------------------------------------------------------------------------
  // urateam#97 / rotulus#17 PR #18: constant-self-equality stub detection
  // ---------------------------------------------------------------------------
  it("flags constant-self-equality stubs even when buried among real assertions (rotulus#17 case)", async () => {
    // Reproduces the PR #18 regression: nav test file had 4 stubs of the
    // form `expect(BRAND_COLOR).toBe(BRAND_COLOR)` mixed in with many
    // real behavioral assertions. Pre-fix, the stubs counted as
    // "behavioral" (toBe matcher), the file's trivialRatio stayed below
    // the 0.8 threshold, and the file was NOT flagged. Post-fix, the
    // stubs are reclassified to trivial AND any non-zero stubAssertions
    // unconditionally flags the file.
    const content = `
describe("nav constants", () => {
  it("uses brand color", () => { expect(BRAND_COLOR).toBe(BRAND_COLOR); });
  it("uses bg color", () => { expect(TAB_BAR_BG).toBe(TAB_BAR_BG); });
  it("uses inactive color", () => { expect(TAB_INACTIVE_COLOR).toBe(TAB_INACTIVE_COLOR); });
  it("uses ac3", () => { expect(AC3).toBe(AC3); });
  it("real test 1", () => { expect(getValue()).toEqual({ a: 1, b: 2 }); });
  it("real test 2", () => { expect(items).toHaveLength(3); });
  it("real test 3", () => { expect(spy).toHaveBeenCalledWith("foo"); });
  it("real test 4", () => { expect(promise).resolves.toEqual("done"); });
  it("real test 5", () => { expect(error).toThrow("BadInput"); });
});`;
    mockReadFile({ [join("/worktree", "nav.test.tsx")]: content });

    const result = await checkTestQuality(["nav.test.tsx"], "/worktree");

    expect(result.analyses[0].stubAssertions).toBe(4);
    expect(result.analyses[0].isFlagged).toBe(true);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].description).toContain(
      "4 constant-self-equality stub(s)",
    );
  });

  it("reclassifies expect(X).toEqual(X) and toStrictEqual(X) as trivial too", async () => {
    const content = `
it("a", () => { expect(VAR).toEqual(VAR); });
it("b", () => { expect(VAR2).toStrictEqual(VAR2); });
it("c", () => { expect(real).toBe(42); });`;
    mockReadFile({ [join("/worktree", "x.test.ts")]: content });

    const result = await checkTestQuality(["x.test.ts"], "/worktree");
    const a = result.analyses[0];
    expect(a.stubAssertions).toBe(2);
    // Real `toBe(42)` stays behavioral.
    expect(a.behavioralAssertions).toBe(1);
    // Trivial pool gains the 2 stubs (despite using behavioral matchers).
    expect(a.trivialAssertions).toBe(2);
    expect(a.isFlagged).toBe(true);
  });

  it("matches member-access identifiers (expect(obj.foo).toBe(obj.foo))", async () => {
    const content = `it("a", () => { expect(config.brandColor).toBe(config.brandColor); });`;
    mockReadFile({ [join("/worktree", "y.test.ts")]: content });
    const result = await checkTestQuality(["y.test.ts"], "/worktree");
    expect(result.analyses[0].stubAssertions).toBe(1);
    expect(result.analyses[0].isFlagged).toBe(true);
  });

  it("does NOT flag expect(X).toBe(Y) when identifiers differ (negative control)", async () => {
    const content = `
it("a", () => { expect(actual).toBe(expected); });
it("b", () => { expect(brandColor).toBe(theme.brandColor); });
it("c", () => { expect(items).toEqual([1, 2, 3]); });`;
    mockReadFile({ [join("/worktree", "z.test.ts")]: content });

    const result = await checkTestQuality(["z.test.ts"], "/worktree");
    expect(result.analyses[0].stubAssertions).toBe(0);
    expect(result.analyses[0].behavioralAssertions).toBe(3);
    expect(result.analyses[0].isFlagged).toBe(false);
    expect(result.violations).toHaveLength(0);
  });

  it("flags a file where ONE test has a constant-self-equality stub (no dilution-grace)", async () => {
    // The diluted-ratio defense was the rotulus#17 regression. Even one
    // stub in a file with otherwise-real tests should fire the flag.
    const content = `
it("real 1", () => { expect(a).toEqual({ x: 1 }); });
it("real 2", () => { expect(b).toHaveLength(5); });
it("stub", () => { expect(THEME).toBe(THEME); });
it("real 3", () => { expect(spy).toHaveBeenCalledWith("ok"); });`;
    mockReadFile({ [join("/worktree", "mixed.test.ts")]: content });

    const result = await checkTestQuality(["mixed.test.ts"], "/worktree");
    const a = result.analyses[0];
    expect(a.stubAssertions).toBe(1);
    expect(a.behavioralAssertions).toBe(3); // 3 real, 1 stub reclassified out
    // Trivial ratio is 1/4 = 25% — way below the 0.8 threshold. Pre-fix
    // this would NOT have been flagged. Post-fix the unconditional
    // stub-count flag fires.
    expect(a.trivialRatio).toBeLessThan(TRIVIAL_THRESHOLD);
    expect(a.isFlagged).toBe(true);
  });

  it("identifies BEC-52 pattern: 13 tests all with toBeDefined", async () => {
    // Reproduce the problematic BEC-52 dashboard server.test.ts pattern
    const tests = Array.from(
      { length: 13 },
      (_, i) => `  it("test ${i + 1}", () => { expect(app).toBeDefined(); });`,
    ).join("\n");
    const content = `describe("dashboard", () => {\n${tests}\n});`;

    mockReadFile({ [join("/worktree", "server.test.ts")]: content });

    const result = await checkTestQuality(["server.test.ts"], "/worktree");

    expect(result.violations).toHaveLength(1);
    expect(result.analyses[0].trivialAssertions).toBe(13);
    expect(result.analyses[0].behavioralAssertions).toBe(0);
    expect(result.analyses[0].trivialRatio).toBe(1);
    expect(result.analyses[0].isFlagged).toBe(true);
  });
});
