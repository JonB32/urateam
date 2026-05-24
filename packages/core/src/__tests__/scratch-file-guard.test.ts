/**
 * Tier 1a — scratch-file denylist gate.
 *
 * `findScratchFiles` is wired into the pipeline runner just before push and
 * forces draft + a `category: "scratch-files"` blocking finding when any of
 * the agent's added files match the denylist (FINAL_CHECKLIST.md,
 * commit-test-changes.sh, TESTING_COMPLETE.md, *.bak, untracked *.log, etc).
 *
 * The matcher is a pure function so it can be tested without git. The git
 * layer (`enumerateAddedFiles`) is exercised by the runner integration.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { matchScratchPatterns } from "../pipeline/scratch-file-guard.js";

describe("matchScratchPatterns — fires on bad cases", () => {
  it("matches FINAL_CHECKLIST.md at repo root", () => {
    expect(matchScratchPatterns(["FINAL_CHECKLIST.md"])).toEqual([
      "FINAL_CHECKLIST.md",
    ]);
  });

  it("matches TESTING_COMPLETE.md at repo root (TESTING_* pattern)", () => {
    expect(matchScratchPatterns(["TESTING_COMPLETE.md"])).toEqual([
      "TESTING_COMPLETE.md",
    ]);
  });

  it("matches *_REPORT.md (case-insensitive)", () => {
    expect(matchScratchPatterns(["VERIFICATION_REPORT.md"])).toEqual([
      "VERIFICATION_REPORT.md",
    ]);
    expect(matchScratchPatterns(["test_report.md"])).toEqual(["test_report.md"]);
  });

  it("matches TEST_*.md at repo root", () => {
    expect(matchScratchPatterns(["TEST_PLAN.md"])).toEqual(["TEST_PLAN.md"]);
  });

  it("matches FINAL_*.md at repo root", () => {
    expect(matchScratchPatterns(["FINAL_NOTES.md"])).toEqual(["FINAL_NOTES.md"]);
  });

  it("matches *.bak and *.bak.* anywhere", () => {
    expect(matchScratchPatterns(["foo.bak"])).toEqual(["foo.bak"]);
    expect(matchScratchPatterns(["src/utils.ts.bak"])).toEqual(["src/utils.ts.bak"]);
    expect(matchScratchPatterns(["config.bak.20260511"])).toEqual([
      "config.bak.20260511",
    ]);
  });

  it("matches root-level commit-*.sh and run-*.sh", () => {
    expect(matchScratchPatterns(["commit-test-changes.sh"])).toEqual([
      "commit-test-changes.sh",
    ]);
    expect(matchScratchPatterns(["run-verification.sh"])).toEqual([
      "run-verification.sh",
    ]);
  });

  it("matches *.tmp anywhere", () => {
    expect(matchScratchPatterns(["scratch.tmp"])).toEqual(["scratch.tmp"]);
    expect(matchScratchPatterns(["src/foo.tmp"])).toEqual(["src/foo.tmp"]);
  });

  it("matches untracked *.log anywhere", () => {
    expect(matchScratchPatterns(["debug.log"])).toEqual(["debug.log"]);
    expect(matchScratchPatterns(["logs/run.log"])).toEqual(["logs/run.log"]);
  });

  it("matches any new repo-root *.md NOT in the exemption set", () => {
    expect(matchScratchPatterns(["NOTES.md"])).toEqual(["NOTES.md"]);
    expect(matchScratchPatterns(["scratch.md"])).toEqual(["scratch.md"]);
    expect(matchScratchPatterns(["SUMMARY.md"])).toEqual(["SUMMARY.md"]);
  });

  it("returns all matches in input order, deduped", () => {
    const matches = matchScratchPatterns([
      "FINAL_CHECKLIST.md",
      "src/foo.ts",
      "commit-test.sh",
      "debug.log",
    ]);
    expect(matches).toEqual([
      "FINAL_CHECKLIST.md",
      "commit-test.sh",
      "debug.log",
    ]);
  });
});

describe("matchScratchPatterns — does NOT fire on clean diffs", () => {
  it("does not match repo-root README.md (tracked exemption)", () => {
    expect(matchScratchPatterns(["README.md"])).toEqual([]);
  });

  it("does not match repo-root CLAUDE.md (tracked exemption)", () => {
    expect(matchScratchPatterns(["CLAUDE.md"])).toEqual([]);
  });

  it("does not match repo-root CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, LICENSE.md, AUTHORS.md", () => {
    expect(
      matchScratchPatterns([
        "CHANGELOG.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "CODE_OF_CONDUCT.md",
        "LICENSE.md",
        "AUTHORS.md",
      ]),
    ).toEqual([]);
  });

  it("does not match exemptions case-insensitively (Readme.md, Changelog.md)", () => {
    expect(matchScratchPatterns(["Readme.md", "Changelog.md"])).toEqual([]);
  });

  it("does not match docs in subdirectories (docs/foo.md, .github/PULL_REQUEST_TEMPLATE.md)", () => {
    expect(
      matchScratchPatterns([
        "docs/feature.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
        "packages/core/README.md",
      ]),
    ).toEqual([]);
  });

  it("does not match real source files (src/foo.ts, packages/core/src/runner.ts, scripts/sync.ts)", () => {
    expect(
      matchScratchPatterns([
        "src/foo.ts",
        "packages/core/src/pipeline/runner.ts",
        "scripts/gh-linear-sync.ts",
        "tests/foo.test.ts",
      ]),
    ).toEqual([]);
  });

  it("does not match nested .sh scripts (scripts/setup.sh) — only root commit-*.sh / run-*.sh", () => {
    expect(matchScratchPatterns(["scripts/setup.sh", "deploy/restart.sh"])).toEqual([]);
  });

  it("returns empty array for an empty input", () => {
    expect(matchScratchPatterns([])).toEqual([]);
  });
});

describe("findScratchFiles env-var escape hatch", () => {
  const ENV_KEY = "URATEAM_DISABLE_SCRATCH_GUARD";
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("when URATEAM_DISABLE_SCRATCH_GUARD=true, returns skipped=true and empty files (no git work)", async () => {
    process.env[ENV_KEY] = "true";
    const { findScratchFiles } = await import("../pipeline/scratch-file-guard.js");
    const result = await findScratchFiles("/nonexistent/path", "main");
    expect(result).toEqual({ files: [], skipped: true });
  });

  it("when URATEAM_DISABLE_SCRATCH_GUARD is unset, gate is active (returns skipped=false)", async () => {
    // We don't have a real worktree here, so we just confirm skipped is false.
    // The git layer is exercised by the runner integration tests.
    const { findScratchFiles } = await import("../pipeline/scratch-file-guard.js");
    // Use a path that exists but is not a git repo so git commands return [].
    const result = await findScratchFiles("/tmp", "main");
    expect(result.skipped).toBe(false);
  });
});
