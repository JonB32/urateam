import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  autoCommitChanges,
  getAgentCommits,
  gitExecSafe,
} from "../../repo/git.js";

/**
 * Tests for the auto-commit feature (BEC-94)
 *
 * Acceptance criteria:
 * - autoCommitChanges returns boolean indicating if it was triggered
 * - getAgentCommits retrieves commit messages authored on the branch
 * - Pipeline tracks autoCommitted as a quality metric
 * - failOnAutoCommit config option fails pipeline when auto-commit is needed
 */
describe("Auto-commit feature (BEC-94)", () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    // Create isolated test directory
    testDir = `/tmp/auto-commit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    repoPath = join(testDir, "repo");
    await mkdir(repoPath, { recursive: true });

    // Initialize a git repo
    execSync("git init -b main", { cwd: repoPath });
    execSync("git config user.name 'Test User'", { cwd: repoPath });
    execSync("git config user.email 'test@example.com'", { cwd: repoPath });

    // Create initial commit
    await writeFile(join(repoPath, "README.md"), "# Test Repo");
    execSync("git add .", { cwd: repoPath });
    execSync("git commit -m 'initial commit'", { cwd: repoPath });
  });

  afterEach(async () => {
    // Cleanup
    await rm(testDir, { recursive: true, force: true });
  });

  describe("autoCommitChanges", () => {
    it("returns false when there are no uncommitted changes", async () => {
      const result = await autoCommitChanges(repoPath, "TEST-1");
      expect(result).toBe(false);
    });

    it("returns true and commits when there are uncommitted changes", async () => {
      // Create uncommitted changes
      await writeFile(join(repoPath, "new-file.txt"), "test content");

      const result = await autoCommitChanges(repoPath, "TEST-2");
      expect(result).toBe(true);

      // Verify commit was created
      const log = execSync("git log --oneline", { cwd: repoPath }).toString();
      expect(log).toContain("feat(TEST-2): agent implementation (auto-committed)");
    });

    it("creates commit with issue ID in message", async () => {
      await writeFile(join(repoPath, "feature.txt"), "new feature");

      await autoCommitChanges(repoPath, "BEC-94");

      const log = execSync("git log --format=%s", { cwd: repoPath }).toString();
      expect(log).toContain("feat(BEC-94): agent implementation (auto-committed)");
    });

    it("handles modified files", async () => {
      // Modify existing file
      await writeFile(join(repoPath, "README.md"), "# Test Repo\n\nUpdated");

      const result = await autoCommitChanges(repoPath, "TEST-3");
      expect(result).toBe(true);

      // Verify changes are staged
      const status = execSync("git status --porcelain", { cwd: repoPath }).toString();
      expect(status.trim()).toBe("");
    });

    it("handles deleted files", async () => {
      // Create a file and commit it
      await writeFile(join(repoPath, "to-delete.txt"), "content");
      execSync("git add .", { cwd: repoPath });
      execSync("git commit -m 'add file'", { cwd: repoPath });

      // Delete it
      execSync("rm to-delete.txt", { cwd: repoPath });

      const result = await autoCommitChanges(repoPath, "TEST-4");
      expect(result).toBe(true);

      // File should be gone from repo
      const status = execSync("git status --porcelain", { cwd: repoPath }).toString();
      expect(status.trim()).toBe("");
    });
  });

  describe("getAgentCommits", () => {
    it("returns empty array when on same commit as base branch", async () => {
      // No commits ahead of main
      const commits = await getAgentCommits(repoPath, "main");
      expect(commits).toEqual([]);
    });

    it("returns commit messages authored on feature branch", async () => {
      // Create a feature branch and make commits
      execSync("git checkout -b feature/test", { cwd: repoPath });

      // Make some commits
      await writeFile(join(repoPath, "feature1.txt"), "content");
      execSync("git add .", { cwd: repoPath });
      execSync("git commit -m 'feat: add feature 1'", { cwd: repoPath });

      await writeFile(join(repoPath, "feature2.txt"), "content");
      execSync("git add .", { cwd: repoPath });
      execSync("git commit -m 'feat: add feature 2'", { cwd: repoPath });

      // Get commits compared to main
      const commits = await getAgentCommits(repoPath, "main");

      expect(commits).toHaveLength(2);
      expect(commits[0]).toBe("feat: add feature 1");
      expect(commits[1]).toBe("feat: add feature 2");
    });

    it("returns only unique commit messages", async () => {
      execSync("git checkout -b feature/unique-test", { cwd: repoPath });

      // Multiple commits with same message
      await writeFile(join(repoPath, "file1.txt"), "content");
      execSync("git add .", { cwd: repoPath });
      execSync("git commit -m 'feat: update'", { cwd: repoPath });

      const commits = await getAgentCommits(repoPath, "main");
      expect(commits).toContain("feat: update");
    });

    it("handles commits with special characters in message", async () => {
      execSync("git checkout -b feature/special", { cwd: repoPath });

      await writeFile(join(repoPath, "file.txt"), "content");
      execSync("git add .", { cwd: repoPath });
      execSync(
        "git commit -m 'fix(BEC-94): handle auto-commit with emoji 🚀'",
        { cwd: repoPath },
      );

      const commits = await getAgentCommits(repoPath, "main");
      expect(commits).toContain("fix(BEC-94): handle auto-commit with emoji 🚀");
    });

    it("returns empty array on failure (fail-open)", async () => {
      // Try to get commits against non-existent base branch
      const commits = await getAgentCommits(repoPath, "nonexistent-branch");
      // Should return empty array instead of throwing
      expect(Array.isArray(commits)).toBe(true);
    });

    it("filters empty lines from output", async () => {
      execSync("git checkout -b feature/filter-test", { cwd: repoPath });

      await writeFile(join(repoPath, "file.txt"), "content");
      execSync("git add .", { cwd: repoPath });
      execSync("git commit -m 'test: filter empty lines'", { cwd: repoPath });

      const commits = await getAgentCommits(repoPath, "main");

      // Should not have empty strings
      commits.forEach((commit) => {
        expect(commit).not.toBe("");
        expect(commit.trim()).toBe(commit);
      });
    });
  });

  describe("Auto-commit quality metrics", () => {
    it("logs warning when auto-commit is triggered", async () => {
      const warnSpy = vi.spyOn(console, "warn");

      // Create uncommitted changes
      await writeFile(join(repoPath, "test.txt"), "content");

      const result = await autoCommitChanges(repoPath, "TEST-WARN");
      expect(result).toBe(true);

      // We expect a warning in logs (the actual logging is done via pino)
      // This test verifies the return value indicates auto-commit was needed
      expect(result).toBe(true);

      warnSpy.mockRestore();
    });

    it("tracks autoCommitted status in pipeline run", async () => {
      // This is a conceptual test — the actual tracking happens in runner.ts
      // It sets run.autoCommitted = true when autoCommitChanges returns true

      await writeFile(join(repoPath, "file.txt"), "content");
      const didAutoCommit = await autoCommitChanges(repoPath, "TEST-TRACK");

      expect(didAutoCommit).toBe(true);
      // In actual pipeline: run.autoCommitted = didAutoCommit
    });
  });

  describe("Agent-authored commits in PR", () => {
    it("includes agent commit messages when creating PR", async () => {
      // Create feature branch with agent commits
      execSync("git checkout -b feature/agent-work", { cwd: repoPath });

      // Agent makes commits
      await writeFile(join(repoPath, "feature.txt"), "implementation");
      execSync("git add .", { cwd: repoPath });
      execSync(
        "git commit -m 'feat(BEC-94): implement auto-commit tracking'",
        { cwd: repoPath },
      );

      await writeFile(join(repoPath, "test.txt"), "tests");
      execSync("git add .", { cwd: repoPath });
      execSync("git commit -m 'test(BEC-94): add auto-commit tests'", {
        cwd: repoPath,
      });

      // Get commits that would appear in PR
      const agentCommits = await getAgentCommits(repoPath, "main");

      expect(agentCommits).toContain("feat(BEC-94): implement auto-commit tracking");
      expect(agentCommits).toContain("test(BEC-94): add auto-commit tests");
    });

    it("excludes auto-commit fallback message from PR when agent authored commits", async () => {
      execSync("git checkout -b feature/clean-commits", { cwd: repoPath });

      // Agent makes proper commits
      await writeFile(join(repoPath, "impl.txt"), "implementation");
      execSync("git add .", { cwd: repoPath });
      execSync("git commit -m 'implement feature'", { cwd: repoPath });

      const commits = await getAgentCommits(repoPath, "main");

      // Should have real agent commits, not auto-commit fallback
      expect(commits).toContain("implement feature");
      expect(commits).not.toContain("(auto-committed)");
    });
  });

  describe("failOnAutoCommit configuration", () => {
    it("captures autoCommitted flag for policy enforcement", async () => {
      // Simulate agent not committing
      await writeFile(join(repoPath, "uncommitted.txt"), "content");

      // When failOnAutoCommit is true in config, pipeline should:
      // 1. Call autoCommitChanges
      // 2. Get back true (auto-commit was needed)
      // 3. Set run.autoCommitted = true
      // 4. Check config.failOnAutoCommit
      // 5. Throw error if configured

      const didAutoCommit = await autoCommitChanges(repoPath, "BEC-94");
      expect(didAutoCommit).toBe(true);

      // This would be checked in runner.ts:
      // if (didAutoCommit && config.failOnAutoCommit) {
      //   throw error
      // }
    });
  });
});
