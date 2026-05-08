import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { extractHandoff } from "../executor/extract-handoff.js";

const validArtifact = {
  summary: "Fixed the bug",
  filesChanged: ["src/index.ts"],
  approach: "Updated the logic",
  context: {
    issueIntent: "Fix bug",
    constraints: [],
    assumptions: [],
  },
  tokenBudget: {
    contextTokensUsed: 1000,
    recommendedMaxTurns: 10,
  },
};

function wrapInJsonBlock(obj: unknown): string {
  return `Here is the result:\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n\nDone.`;
}

/** Create a temp git repo with an initial commit and a modified file */
async function createTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "file.txt"), "initial");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  // Make a change so git diff has output
  await writeFile(join(dir, "file.txt"), "modified");
  return dir;
}

describe("extractHandoff", () => {
  it("uses fast path when agent already produced valid JSON", async () => {
    const output = wrapInJsonBlock(validArtifact);
    const result = await extractHandoff(output, "run-1", "ISS-1", "implement", "/tmp");
    expect(result.structured).toBe(true);
    expect(result.artifact.summary).toBe("Fixed the bug");
    expect(result.artifact.runId).toBe("run-1");
  });

  it("metadata always overrides agent-supplied identity fields", async () => {
    const malicious = {
      ...validArtifact,
      runId: "injected-run",
      stage: "injected-stage",
      issueId: "injected-issue",
    };
    const output = wrapInJsonBlock(malicious);
    const result = await extractHandoff(output, "run-1", "ISS-1", "implement", "/tmp");
    expect(result.structured).toBe(true);
    expect(result.artifact.runId).toBe("run-1");
    expect(result.artifact.issueId).toBe("ISS-1");
    expect(result.artifact.stage).toBe("implement");
  });

  it("builds handoff from git diff when no JSON in agent output", async () => {
    const dir = await createTestRepo();
    try {
      const result = await extractHandoff(
        "I modified file.txt with the fix.",
        "run-1",
        "ISS-1",
        "implement",
        dir,
      );
      expect(result.structured).toBe(false); // git-fallback is not agent-produced JSON
      expect(result.artifact.filesChanged).toContain("file.txt");
      expect(result.artifact.approach).toContain("1 file(s)");
      expect(result.artifact.stage).toBe("implement");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes untracked new files in filesChanged", async () => {
    const dir = await createTestRepo();
    try {
      // Create a new file without staging it
      await writeFile(join(dir, "newfile.ts"), "export const x = 1;");

      const result = await extractHandoff(
        "Created newfile.ts with the implementation.",
        "run-1",
        "ISS-1",
        "implement",
        dir,
      );
      expect(result.structured).toBe(false); // git-fallback is not agent-produced JSON
      // Both modified and untracked files should appear
      expect(result.artifact.filesChanged).toContain("file.txt");
      expect(result.artifact.filesChanged).toContain("newfile.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds handoff with empty filesChanged when no git changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "file.txt"), "content");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    // No changes after commit

    try {
      const result = await extractHandoff(
        "Reviewed the code, no changes needed.",
        "run-1",
        "ISS-1",
        "review",
        dir,
      );
      expect(result.structured).toBe(false); // git-fallback is not agent-produced JSON
      expect(result.artifact.filesChanged).toEqual([]);
      expect(result.artifact.approach).toContain("No file changes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses agent output for summary when no JSON block", async () => {
    const dir = await createTestRepo();
    try {
      const result = await extractHandoff(
        "Line one\nLine two\nThe fix was applied to handle the edge case correctly.",
        "run-1",
        "ISS-1",
        "implement",
        dir,
      );
      expect(result.structured).toBe(false); // git-fallback is not agent-produced JSON
      expect(result.artifact.summary).toContain("edge case");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // urateam#35: empty filesChanged in agent JSON + real git changes
  // ---------------------------------------------------------------------------
  it("overrides empty agent filesChanged with git diff when worktree has real changes (urateam#35)", async () => {
    const dir = await createTestRepo();
    try {
      // Agent emits structurally-valid JSON but claims no files changed —
      // reproduces the rotulus PR #7 case.
      const brokenArtifact = {
        ...validArtifact,
        filesChanged: [],
        summary: "Implementation complete.",
      };
      const output = wrapInJsonBlock(brokenArtifact);
      const result = await extractHandoff(output, "run-1", "ISS-1", "implement", dir);

      expect(result.structured).toBe(true); // fast path still wins (agent JSON parsed)
      // BUT filesChanged must be populated from git, not the agent's empty list
      expect(result.artifact.filesChanged).toContain("file.txt");
      expect(result.artifact.filesChanged.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does NOT override agent filesChanged when the agent supplied a non-empty list", async () => {
    // Even if git would report different paths, we trust the agent's
    // intentional list (e.g., when it filters out generated files). The
    // urateam#35 sanity check only fires on empty.
    const dir = await createTestRepo();
    try {
      const artifactWithFiles = {
        ...validArtifact,
        filesChanged: ["src/auth.ts", "src/middleware.ts"],
      };
      const output = wrapInJsonBlock(artifactWithFiles);
      const result = await extractHandoff(output, "run-1", "ISS-1", "implement", dir);

      expect(result.structured).toBe(true);
      expect(result.artifact.filesChanged).toEqual(["src/auth.ts", "src/middleware.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves empty filesChanged when worktree truly has no changes (no false override)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
    execFileSync("git", ["init"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    await writeFile(join(dir, "file.txt"), "content");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    // No worktree changes after commit.

    try {
      const reviewArtifact = {
        ...validArtifact,
        filesChanged: [],
        summary: "Reviewed code, no changes needed.",
      };
      const output = wrapInJsonBlock(reviewArtifact);
      const result = await extractHandoff(output, "run-1", "ISS-1", "review", dir);

      expect(result.structured).toBe(true);
      // Agent and git both agree → empty stays empty.
      expect(result.artifact.filesChanged).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not crash the fast path if the git status check fails (override is best-effort)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
    // Not a git repo. `gitExecRaw` resolves to "" on git error (it
    // fails-open rather than rejecting), so `parseGitPorcelain("")`
    // returns [] and the override naturally short-circuits.
    try {
      const brokenArtifact = { ...validArtifact, filesChanged: [] };
      const output = wrapInJsonBlock(brokenArtifact);
      const result = await extractHandoff(output, "run-1", "ISS-1", "implement", dir);

      // Fast path still wins; empty filesChanged preserved (no git to consult).
      expect(result.structured).toBe(true);
      expect(result.artifact.filesChanged).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("override picks up branch-committed files when worktree is clean (urateam#35 widened, autoCommit gap)", async () => {
    // Reproduces the rotulus PR #16 case from the OSS validation run: the
    // implement stage modifies files and autoCommitChanges runs between
    // stages. By the time the review stage's extractHandoff runs, the
    // worktree is CLEAN — `git status --porcelain` returns nothing — and
    // the empty-filesChanged override from PR #95 doesn't fire (status-only).
    //
    // Widened fix: when baseRef is supplied, also consult
    // `git diff --name-only baseRef...HEAD` so the committed-on-branch
    // files surface. This test simulates the autoCommit boundary by
    // committing a feature edit on a feature branch with a baseline tag
    // serving as baseRef.
    const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      // Initial commit — establishes the base.
      await writeFile(join(dir, "existing.ts"), "export const a = 1;");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      // Set up a fake `origin/main` so the prod `origin/main` ref form
      // resolves in the test repo. update-ref creates it without a remote.
      execFileSync(
        "git",
        ["update-ref", "refs/remotes/origin/main", "HEAD"],
        { cwd: dir },
      );
      // Branch + commit two feature files, then leave the worktree clean
      // (mirrors what autoCommitChanges produces).
      execFileSync("git", ["checkout", "-b", "agent/iss-1"], { cwd: dir });
      await writeFile(join(dir, "feature-a.ts"), "export const x = 1;");
      await writeFile(join(dir, "feature-b.ts"), "export const y = 2;");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "feat: add features"], { cwd: dir });

      // Sanity check: `git status` is empty (autoCommit-clean state).
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir })
        .toString();
      expect(status.trim()).toBe("");

      // Agent emits structurally-valid JSON but with empty filesChanged.
      const brokenArtifact = { ...validArtifact, filesChanged: [] };
      const output = wrapInJsonBlock(brokenArtifact);
      const result = await extractHandoff(
        output,
        "run-1",
        "ISS-1",
        "review",
        dir,
        "origin/main",
      );

      expect(result.structured).toBe(true);
      // Both feature files surface from the branch-vs-base diff, not status.
      expect(result.artifact.filesChanged).toContain("feature-a.ts");
      expect(result.artifact.filesChanged).toContain("feature-b.ts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedupes files that show up in BOTH worktree status and branch-vs-base diff", async () => {
    // Edge case: agent committed feature-a, then made an additional
    // uncommitted edit to it. Should appear once, not twice.
    const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      await writeFile(join(dir, "existing.ts"), "export const a = 1;");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: dir });
      execFileSync("git", ["checkout", "-b", "agent/iss-2"], { cwd: dir });
      await writeFile(join(dir, "feature.ts"), "export const x = 1;");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "feat: feature"], { cwd: dir });
      // Now modify the same file again — uncommitted.
      await writeFile(join(dir, "feature.ts"), "export const x = 99;");

      const brokenArtifact = { ...validArtifact, filesChanged: [] };
      const output = wrapInJsonBlock(brokenArtifact);
      const result = await extractHandoff(
        output, "run-1", "ISS-1", "review", dir, "origin/main",
      );

      expect(result.structured).toBe(true);
      const occurrences = result.artifact.filesChanged.filter((f) => f === "feature.ts").length;
      expect(occurrences).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to status-only when baseRef is undefined (back-compat with PR #95)", async () => {
    // Existing callers that don't pass baseRef must keep getting the
    // PR #95 behavior (worktree-only). This guards the optional-arg contract.
    const dir = await createTestRepo();
    try {
      const brokenArtifact = { ...validArtifact, filesChanged: [] };
      const output = wrapInJsonBlock(brokenArtifact);
      const result = await extractHandoff(output, "run-1", "ISS-1", "implement", dir);
      // Worktree has the modified file.txt from createTestRepo; override fires.
      expect(result.structured).toBe(true);
      expect(result.artifact.filesChanged).toContain("file.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("override correctly resolves renamed files to the new name (parseGitPorcelain XY old -> new)", async () => {
    // Build a clean repo state with a single committed file, then do
    // ONLY a rename so porcelain emits the rename arrow form unambiguously.
    const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      await writeFile(join(dir, "original.txt"), "content");
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      execFileSync("git", ["mv", "original.txt", "renamed.txt"], { cwd: dir });

      const brokenArtifact = { ...validArtifact, filesChanged: [] };
      const output = wrapInJsonBlock(brokenArtifact);
      const result = await extractHandoff(output, "run-1", "ISS-1", "implement", dir);

      expect(result.structured).toBe(true);
      // parseGitPorcelain extracts the post-rename name, not the pre-rename one.
      expect(result.artifact.filesChanged).toContain("renamed.txt");
      expect(result.artifact.filesChanged).not.toContain("original.txt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // urateam#97: JSON-soup summary sanitization (slow path)
  // ---------------------------------------------------------------------------
  it("replaces JSON-soup summary text with a deterministic placeholder (urateam#97 rotulus#7 case)", async () => {
    // Reproduces the exact pattern from rotulus PR #7: the review-stage
    // agent emits review-finding JSON arrays (different schema than
    // HandoffArtifact). The previous slow-path scraped the last 5 lines
    // verbatim into `summary`, leaking JSON fragments into the rendered
    // PR body's "## Summary" section.
    const dir = await createTestRepo();
    try {
      const reviewFindingsLeak = [
        "Done analyzing.",
        '"description": "patchMeSchema uses Zod default strip — fields silently dropped.",',
        '"fix": "Append .strict() to patchMeSchema",',
        '"severity": "warning"',
        "}]",
      ].join("\n");

      const result = await extractHandoff(reviewFindingsLeak, "run-1", "ISS-1", "review", dir);
      expect(result.structured).toBe(false);
      // Must NOT contain the leaked JSON fragments
      expect(result.artifact.summary).not.toContain('"description"');
      expect(result.artifact.summary).not.toContain('"fix"');
      expect(result.artifact.summary).not.toContain('"severity"');
      // Must have the deterministic placeholder
      expect(result.artifact.summary).toContain("Stage review completed");
      expect(result.artifact.summary).toContain("see Changes for files modified");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves prose summary when agent output is normal text (no false positive)", async () => {
    // Negative control: the JSON-soup heuristic should NOT fire on
    // legitimate prose summaries.
    const dir = await createTestRepo();
    try {
      const prose = [
        "Completed implementation of the search endpoint.",
        "Added pagination support and input validation.",
        "All tests pass.",
      ].join("\n");

      const result = await extractHandoff(prose, "run-1", "ISS-1", "implement", dir);
      expect(result.structured).toBe(false);
      expect(result.artifact.summary).toContain("search endpoint");
      expect(result.artifact.summary).toContain("All tests pass");
      // Sanity: not the placeholder
      expect(result.artifact.summary).not.toContain("not parseable prose");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves prose with incidental quoted phrases (no over-eager pattern match)", async () => {
    // Edge case: prose that mentions a JSON-shaped phrase by coincidence
    // (e.g., "the description: field is missing"). The heuristic requires
    // 3+ `"x":"` patterns OR an opening { / [ followed by JSON structure,
    // neither of which fires here.
    const dir = await createTestRepo();
    try {
      const prose = "Implementation done. The description field on User model now accepts emojis.";
      const result = await extractHandoff(prose, "run-1", "ISS-1", "implement", dir);
      expect(result.structured).toBe(false);
      expect(result.artifact.summary).toContain("emojis");
      expect(result.artifact.summary).not.toContain("not parseable prose");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves prose starting with checklist or tag prefixes (no false positive on `[x]`/`[PASS]`)", async () => {
    // Sonnet review of PR #110 caught: agent output often ends with
    // checklist items like `[x] tests pass` or tag-prefixed lines like
    // `[PASS] all checks` / `[fix] update schema`. The previous
    // `^[\s\[\{]` heuristic fired on these. Tightened to require an
    // actual JSON opener (`[{` or `{"`) after the bracket.
    const dir = await createTestRepo();
    try {
      const checklistTail = [
        "[x] feature implemented",
        "[x] tests pass",
        "[PASS] lint",
      ].join("\n");
      const result = await extractHandoff(checklistTail, "run-1", "ISS-1", "test", dir);
      expect(result.structured).toBe(false);
      expect(result.artifact.summary).toContain("[x]");
      expect(result.artifact.summary).toContain("PASS");
      expect(result.artifact.summary).not.toContain("not parseable prose");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves config-change prose with two quoted attribute pairs (threshold guard)", async () => {
    // Sonnet review of PR #110 caught: prose like
    // `Added "env": "production" and "debug": "false" in config` was
    // tripping the c3 heuristic when its threshold was 2. Raised to 3.
    const dir = await createTestRepo();
    try {
      const configProse = 'Added "env": "production" and "debug": "false" to the staging config.';
      const result = await extractHandoff(configProse, "run-1", "ISS-1", "implement", dir);
      expect(result.structured).toBe(false);
      expect(result.artifact.summary).toContain("staging config");
      expect(result.artifact.summary).not.toContain("not parseable prose");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("JSON-soup detection still fires when baseRef is provided (slow-path coverage)", async () => {
    // Coverage gap from PR #110 — the original 3 tests didn't pass baseRef.
    // The widened union helper from PR #104 doesn't change the soup
    // detection path, but the test surface should exercise both args.
    const dir = await createTestRepo();
    try {
      const reviewFindingsLeak = '[{"description": "issue", "fix": "fix it", "severity": "blocking", "category": "Other"}]';
      const result = await extractHandoff(
        reviewFindingsLeak,
        "run-1",
        "ISS-1",
        "review",
        dir,
        "origin/main",
      );
      expect(result.structured).toBe(false);
      expect(result.artifact.summary).not.toContain('"description"');
      expect(result.artifact.summary).toContain("Stage review completed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // BEC-167: Review stage HandoffArtifact envelope — no soup-gate placeholder
  // ---------------------------------------------------------------------------
  it("review stage HandoffArtifact with reviewFindings parses as structured (BEC-167)", async () => {
    // Reproduces the fix for BEC-167: the review agent now emits a full
    // HandoffArtifact envelope. This must parse via the fast path
    // (structured: true) and produce a real prose summary — not the
    // "not parseable prose" soup-gate placeholder.
    const reviewArtifact = {
      stage: "review",
      summary: "The implementation looks correct. No blocking issues found.",
      filesChanged: ["packages/core/src/security/review-checklist.ts"],
      approach: "Updated the output format to emit a HandoffArtifact envelope.",
      context: {
        issueIntent: "Fix review stage placeholder output",
        constraints: [],
        assumptions: [],
        reviewFindings: [],
      },
      tokenBudget: {
        contextTokensUsed: 500,
        recommendedMaxTurns: 10,
      },
    };
    const output = wrapInJsonBlock(reviewArtifact);
    const result = await extractHandoff(output, "run-1", "ISS-1", "review", "/tmp");

    // Must take the fast path — structured agent output, not git fallback
    expect(result.structured).toBe(true);
    // Summary must be real prose, NOT the soup-gate placeholder
    expect(result.artifact.summary).toBe("The implementation looks correct. No blocking issues found.");
    expect(result.artifact.summary).not.toContain("not parseable prose");
    expect(result.artifact.summary).not.toContain("Stage review completed");
    // reviewFindings accessible via context
    expect(result.artifact.context.reviewFindings).toEqual([]);
  });

  it("review stage HandoffArtifact with blocking findings parses correctly (BEC-167)", async () => {
    // Verifies that reviewFindings inside context round-trips through
    // parseHandoffArtifact — downstream stages (review-fix loop, fanout)
    // read handoff.context.reviewFindings to detect blocking issues.
    const reviewArtifact = {
      stage: "review",
      summary: "Found one blocking security issue: SQL injection in user query.",
      filesChanged: ["src/db/user-query.ts"],
      approach: "Reviewed user query builder for injection vulnerabilities.",
      context: {
        issueIntent: "Add user search endpoint",
        constraints: [],
        assumptions: [],
        reviewFindings: [
          {
            severity: "blocking",
            file: "src/db/user-query.ts",
            line: 42,
            category: "SQL Injection",
            description: "Unparameterized query allows SQL injection.",
            fix: "Use parameterized statements via the ORM.",
          },
        ],
      },
      tokenBudget: {
        contextTokensUsed: 800,
        recommendedMaxTurns: 10,
      },
    };
    const output = wrapInJsonBlock(reviewArtifact);
    const result = await extractHandoff(output, "run-1", "ISS-1", "review", "/tmp");

    expect(result.structured).toBe(true);
    expect(result.artifact.summary).toContain("SQL injection");
    expect(result.artifact.summary).not.toContain("not parseable prose");
    // reviewFindings must be accessible for the review-fix loop in runner.ts
    expect(result.artifact.context.reviewFindings).toHaveLength(1);
    expect(result.artifact.context.reviewFindings![0].severity).toBe("blocking");
    expect(result.artifact.context.reviewFindings![0].category).toBe("SQL Injection");
  });

  it("returns structured: false when git diff fails (not a git repo)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "extract-test-"));
    // Not a git repo — no .git directory
    try {
      const result = await extractHandoff(
        "Did some work.",
        "run-1",
        "ISS-1",
        "implement",
        dir,
      );
      // Git-fallback path always returns structured: false (not agent-produced JSON)
      expect(result.structured).toBe(false);
      expect(result.artifact.filesChanged).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
