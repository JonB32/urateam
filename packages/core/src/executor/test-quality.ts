/**
 * Test Quality Validator
 *
 * Scans test files for assertion quality after the test stage completes.
 * Flags files with predominantly trivial assertions (toBeDefined, toBeTruthy, etc.)
 * and requires at least one behavioral assertion per test function.
 *
 * Documented rules for trivial vs behavioral assertion classification:
 *
 * TRIVIAL assertions (only verify existence/truthiness, not specific behavior):
 *   - toBeDefined()      — only checks value is not undefined
 *   - toBeTruthy()       — only checks value is truthy
 *   - toBeFalsy()        — only checks value is falsy
 *   - toBeNull()         — only checks value is null
 *   - toBeUndefined()    — only checks value is undefined
 *
 * BEHAVIORAL assertions (verify specific values, structure, or interactions):
 *   - toEqual(...)         — deep equality check
 *   - toStrictEqual(...)   — strict deep equality
 *   - toBe(...)            — reference / primitive equality
 *   - toContain(...)       — substring or array element check
 *   - toContainEqual(...)  — array element deep equality
 *   - toHaveBeenCalledWith(...) — spy call argument verification
 *   - toHaveBeenCalled()   — spy invocation check
 *   - toHaveBeenCalledTimes(...) — spy call count
 *   - toMatch(...)         — regex or substring match
 *   - toThrow(...)         — error thrown with specific message/type
 *   - toThrowError(...)    — alias for toThrow
 *   - toHaveLength(...)    — array/string length check
 *   - toHaveProperty(...)  — object property check
 *   - toMatchObject(...)   — partial object match
 *   - toMatchSnapshot()    — snapshot comparison
 *   - toMatchInlineSnapshot(...) — inline snapshot comparison
 *   - toBeGreaterThan(...) — numeric comparison
 *   - toBeGreaterThanOrEqual(...) — numeric comparison
 *   - toBeLessThan(...)    — numeric comparison
 *   - toBeLessThanOrEqual(...) — numeric comparison
 *   - toBeCloseTo(...)     — floating point comparison
 *   - toBeInstanceOf(...)  — type check
 *   - toHaveReturnedWith(...) — spy return value check
 *   - toHaveLastReturnedWith(...) — spy last return check
 *   - rejects             — promise rejection assertion
 *   - resolves            — promise resolution assertion
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { ReviewFinding } from "../types.js";

const log = createLogger({ component: "TestQuality" });

/**
 * Trivial assertion matchers — only check existence or truthiness,
 * not any specific behavior or value.
 */
export const TRIVIAL_MATCHERS = [
  "toBeDefined",
  "toBeTruthy",
  "toBeFalsy",
  "toBeNull",
  "toBeUndefined",
] as const;

/**
 * Behavioral assertion matchers — verify specific values, structure, or interactions.
 */
export const BEHAVIORAL_MATCHERS = [
  "toEqual",
  "toStrictEqual",
  "toBe",
  "toContain",
  "toContainEqual",
  "toHaveBeenCalledWith",
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveBeenNthCalledWith",
  "toHaveBeenLastCalledWith",
  "toMatch",
  "toThrow",
  "toThrowError",
  "toHaveLength",
  "toHaveProperty",
  "toMatchObject",
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeCloseTo",
  "toBeInstanceOf",
  "toHaveReturnedWith",
  "toHaveLastReturnedWith",
  "toHaveNthReturnedWith",
  "toHaveReturned",
  "toSatisfy",
  "toMatchTypeOf",
] as const;

/**
 * Ratio of trivial assertions above which a test file is flagged.
 * Files with >80% trivial assertions are considered low quality.
 */
export const TRIVIAL_THRESHOLD = 0.8;

/**
 * Regex for "constant-self-equality" stubs: `expect(X).toBe(X)`,
 * `expect(X).toEqual(X)`, or `expect(X).toStrictEqual(X)` where the
 * same identifier (possibly with member access like `obj.foo`) appears on
 * both sides. These use behavioral matchers but assert a tautology
 * (X === X) — which is always true and verifies nothing meaningful.
 *
 * Reclassified as trivial in countAssertions(). Triggers an unconditional
 * flag (not just when the file's overall trivial ratio is high) — these
 * patterns are unambiguous stubs and shouldn't ship even when diluted
 * by real assertions elsewhere in the file.
 *
 * Pattern observed in rotulus#17 PR #18 where the agent left
 * `expect(BRAND_COLOR).toBe(BRAND_COLOR)` and similar stubs intact —
 * the previous detector counted them as behavioral and the file passed.
 * See urateam#97 evidence comment.
 */
export const CONSTANT_SELF_EQUALITY_PATTERN =
  /\bexpect\s*\(\s*([\w$][\w$.]*)\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g;

/**
 * Glob-style test file name patterns.
 */
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /__tests__\/.*\.[jt]sx?$/,
];

/**
 * Analysis result for a single test file.
 */
export interface TestFileAnalysis {
  /** Absolute or relative file path */
  file: string;
  /** Total assertions (trivial + behavioral) */
  totalAssertions: number;
  /** Number of trivial assertions (includes constant-self-equality stubs) */
  trivialAssertions: number;
  /** Number of behavioral assertions */
  behavioralAssertions: number;
  /**
   * Number of constant-self-equality stubs (`expect(X).toBe(X)` etc).
   * Subset of trivialAssertions — already counted there. Tracked
   * separately so the violation description can call them out specifically.
   */
  stubAssertions: number;
  /** Ratio of trivial to total (0–1) */
  trivialRatio: number;
  /** Test function names that contain no behavioral assertion */
  testsWithoutBehavioralAssertion: string[];
  /** Whether this file should be flagged for low-quality assertions */
  isFlagged: boolean;
}

/**
 * Overall result of test quality checking across all test files.
 */
export interface TestQualityResult {
  /** ReviewFinding items suitable for injecting into the handoff */
  violations: ReviewFinding[];
  /** Per-file analysis details */
  analyses: TestFileAnalysis[];
}

/**
 * Returns true if the file path looks like a test file.
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Extracts test blocks from source content.
 * Each block contains the test name and the source text from the opening
 * `it(` / `test(` call through the start of the next test (or end of file).
 * This is intentionally a lightweight heuristic — it does not parse ASTs.
 */
export function extractTestBlocks(content: string): Array<{ name: string; content: string }> {
  const blocks: Array<{ name: string; content: string }> = [];

  // Match `it("name", ...)` or `test("name", ...)` with single, double, or backtick quotes
  const testPattern = /\b(?:it|test)\s*\(\s*(['"`])([\s\S]*?)\1/g;

  const positions: Array<{ pos: number; name: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = testPattern.exec(content)) !== null) {
    // Skip "it.each", "test.each", "it.skip", "test.todo" etc. where there's no actual body
    // (they still have a body but this is fine — we just check what assertions are in the text slice)
    positions.push({ pos: match.index, name: match[2].trim() });
  }

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].pos;
    const end = i + 1 < positions.length ? positions[i + 1].pos : content.length;
    blocks.push({
      name: positions[i].name,
      content: content.slice(start, end),
    });
  }

  return blocks;
}

/**
 * Counts the number of constant-self-equality stubs in the given content.
 * Resets the regex `lastIndex` defensively since the pattern is /g.
 */
function countStubAssertions(content: string): number {
  CONSTANT_SELF_EQUALITY_PATTERN.lastIndex = 0;
  return Array.from(content.matchAll(CONSTANT_SELF_EQUALITY_PATTERN)).length;
}

/**
 * Counts how many times each assertion group appears in the given content.
 * Constant-self-equality stubs (e.g. `expect(X).toBe(X)`) are reclassified
 * from behavioral to trivial — they use behavioral matchers but assert a
 * tautology and verify nothing.
 */
function countAssertions(content: string): {
  trivial: number;
  behavioral: number;
  stubs: number;
} {
  const trivialPattern = new RegExp(
    `\\.(?:${TRIVIAL_MATCHERS.join("|")})\\s*\\(`,
    "g",
  );
  const behavioralPattern = new RegExp(
    `\\.(?:${BEHAVIORAL_MATCHERS.join("|")})\\s*\\(|\\.(?:rejects|resolves)\\b`,
    "g",
  );

  const rawTrivial = (content.match(trivialPattern) ?? []).length;
  const rawBehavioral = (content.match(behavioralPattern) ?? []).length;
  const stubs = countStubAssertions(content);

  // Each stub match was originally counted in the behavioral pool (the
  // matcher is toBe / toEqual / toStrictEqual). Move them to trivial.
  // Math.max guards against arithmetic surprises if the regex ever picks
  // up something the behavioral counter doesn't (unlikely but defensive).
  return {
    trivial: rawTrivial + stubs,
    behavioral: Math.max(0, rawBehavioral - stubs),
    stubs,
  };
}

/**
 * Analyzes a single test file for assertion quality.
 * Reads the file from disk; returns an empty analysis if the file cannot be read.
 */
export async function analyzeTestFile(filePath: string): Promise<TestFileAnalysis> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    log.warn({ filePath }, "test-quality: could not read file — skipping");
    return {
      file: filePath,
      totalAssertions: 0,
      trivialAssertions: 0,
      behavioralAssertions: 0,
      stubAssertions: 0,
      trivialRatio: 0,
      testsWithoutBehavioralAssertion: [],
      isFlagged: false,
    };
  }

  // File-level counts
  const {
    trivial: trivialAssertions,
    behavioral: behavioralAssertions,
    stubs: stubAssertions,
  } = countAssertions(content);
  const totalAssertions = trivialAssertions + behavioralAssertions;
  const trivialRatio = totalAssertions === 0 ? 0 : trivialAssertions / totalAssertions;

  // Per-test-function check: find tests that have zero behavioral assertions
  const testBlocks = extractTestBlocks(content);
  const testsWithoutBehavioralAssertion: string[] = [];

  for (const block of testBlocks) {
    const { behavioral } = countAssertions(block.content);
    if (behavioral === 0) {
      // Truncate very long test names
      const name = block.name.length > 80 ? block.name.slice(0, 77) + "..." : block.name;
      testsWithoutBehavioralAssertion.push(name);
    }
  }

  const isFlagged =
    (totalAssertions > 0 && trivialRatio > TRIVIAL_THRESHOLD) ||
    (testBlocks.length > 0 && testsWithoutBehavioralAssertion.length === testBlocks.length) ||
    // Constant-self-equality stubs are unambiguous regression markers — flag
    // even one (the rotulus#17 PR #18 case where 4 such stubs slipped through
    // the diluted-ratio check on a file with otherwise-real assertions).
    stubAssertions > 0;

  return {
    file: filePath,
    totalAssertions,
    trivialAssertions,
    behavioralAssertions,
    stubAssertions,
    trivialRatio,
    testsWithoutBehavioralAssertion,
    isFlagged,
  };
}

/**
 * Runs test quality analysis on test files from the list of changed files.
 * Resolves each file path relative to `workdir`, filters for test files,
 * and reports violations as `ReviewFinding` items.
 *
 * @param changedFiles - Files from the handoff `filesChanged` array
 * @param workdir - Worktree root directory
 * @returns Violations (as ReviewFinding[]) and per-file analyses
 */
export async function checkTestQuality(
  changedFiles: string[],
  workdir: string,
): Promise<TestQualityResult> {
  const testFiles = changedFiles.filter(isTestFile);

  if (testFiles.length === 0) {
    log.debug("test-quality: no test files in changed set — skipping");
    return { violations: [], analyses: [] };
  }

  log.info({ testFileCount: testFiles.length }, "test-quality: analysing test files");

  const analyses = await Promise.all(
    testFiles.map((f) => analyzeTestFile(join(workdir, f))),
  );

  const violations: ReviewFinding[] = [];

  for (const analysis of analyses) {
    if (!analysis.isFlagged) continue;

    // Build a human-readable description
    const pct = Math.round(analysis.trivialRatio * 100);
    const details: string[] = [];

    if (analysis.totalAssertions > 0 && analysis.trivialRatio > TRIVIAL_THRESHOLD) {
      details.push(
        `${pct}% of assertions are trivial existence checks ` +
          `(${analysis.trivialAssertions}/${analysis.totalAssertions} are toBeDefined/toBeTruthy/etc.)`,
      );
    }

    if (analysis.stubAssertions > 0) {
      details.push(
        `${analysis.stubAssertions} constant-self-equality stub(s) — ` +
          `expect(X).toBe(X) / .toEqual(X) tautologies that always pass`,
      );
    }

    if (analysis.testsWithoutBehavioralAssertion.length > 0) {
      const names = analysis.testsWithoutBehavioralAssertion.slice(0, 3).join(", ");
      const extra =
        analysis.testsWithoutBehavioralAssertion.length > 3
          ? ` and ${analysis.testsWithoutBehavioralAssertion.length - 3} more`
          : "";
      details.push(
        `${analysis.testsWithoutBehavioralAssertion.length} test(s) have no behavioral assertion: ${names}${extra}`,
      );
    }

    violations.push({
      severity: "warning",
      file: analysis.file,
      line: 1,
      category: "Test Quality",
      description:
        `Test file contains predominantly trivial assertions that verify nothing meaningful. ` +
        details.join(". "),
      fix:
        "Replace toBeDefined()/toBeTruthy() assertions with behavioral assertions that verify " +
        "specific values or interactions: use toEqual(), toContain(), toHaveBeenCalledWith(), " +
        "toMatch(), toThrow(), toHaveLength(), etc.",
    });

    log.warn(
      {
        file: analysis.file,
        trivialRatio: analysis.trivialRatio,
        trivialAssertions: analysis.trivialAssertions,
        behavioralAssertions: analysis.behavioralAssertions,
        stubAssertions: analysis.stubAssertions,
        testsWithoutBehavioralAssertion: analysis.testsWithoutBehavioralAssertion.length,
      },
      "test-quality: flagged file with low-quality assertions",
    );
  }

  if (violations.length === 0) {
    log.info("test-quality: all test files passed assertion quality check");
  } else {
    log.warn(
      { violationCount: violations.length },
      "test-quality: test quality violations found — added as warnings to handoff",
    );
  }

  return { violations, analyses };
}
