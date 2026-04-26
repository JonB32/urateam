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
    // Not a git repo — `git status --porcelain` will error.
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
