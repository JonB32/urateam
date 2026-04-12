import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { branchName, cleanupWorktrees, rebaseBranch, abortRebase } from "../repo/git.js";
import { cloneRepo, fetchLatest } from "../repo/git.js";
import { resolveRepo, parseRepoUrl, parseGitLabUrl } from "../repo/config.js";
import { buildAuthenticatedUrl } from "../repo/gitlab.js";
import type { RepoConfig } from "../types.js";

describe("branchName", () => {
  it("returns correct format", () => {
    expect(branchName("ENG-123", "fix-login")).toBe("agent/ENG-123-fix-login");
  });

  it("handles slugs with multiple dashes", () => {
    expect(branchName("PROJ-42", "add-user-auth-flow")).toBe(
      "agent/PROJ-42-add-user-auth-flow",
    );
  });
});

describe("resolveRepo", () => {
  const repoMap: Record<string, RepoConfig> = {
    "team-1": {
      url: "https://github.com/org/team-repo.git",
      defaultBranch: "main",
      testCommand: "npm test",
      buildCommand: "npm run build",
    },
    "project-a": {
      url: "https://github.com/org/project-repo.git",
      defaultBranch: "develop",
      testCommand: "yarn test",
      buildCommand: "yarn build",
    },
  };

  it("finds by teamId", () => {
    const result = resolveRepo("team-1", undefined, repoMap);
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://github.com/org/team-repo.git");
  });

  it("finds by projectId (takes priority over teamId)", () => {
    const result = resolveRepo("team-1", "project-a", repoMap);
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://github.com/org/project-repo.git");
  });

  it("falls back to teamId when projectId not found", () => {
    const result = resolveRepo("team-1", "unknown-project", repoMap);
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://github.com/org/team-repo.git");
  });

  it("returns null for unknown teamId and no projectId", () => {
    const result = resolveRepo("unknown-team", undefined, repoMap);
    expect(result).toBeNull();
  });

  it("returns null when both teamId and projectId are unknown", () => {
    const result = resolveRepo("unknown-team", "unknown-project", repoMap);
    expect(result).toBeNull();
  });
});

describe("parseRepoUrl", () => {
  it("parses github.com/owner/repo", () => {
    const result = parseRepoUrl("github.com/myorg/myrepo");
    expect(result).toEqual({ owner: "myorg", repo: "myrepo" });
  });

  it("parses https://github.com/owner/repo", () => {
    const result = parseRepoUrl("https://github.com/acme/widgets");
    expect(result).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("parses https://github.com/owner/repo.git", () => {
    const result = parseRepoUrl("https://github.com/acme/widgets.git");
    expect(result).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("parses git@github.com:owner/repo.git", () => {
    const result = parseRepoUrl("git@github.com:acme/widgets.git");
    expect(result).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("throws for invalid URL", () => {
    expect(() => parseRepoUrl("not-a-url")).toThrow(
      "Unable to parse GitHub repo URL",
    );
  });
});

describe("parseGitLabUrl", () => {
  it("parses https://gitlab.com/group/repo", () => {
    const result = parseGitLabUrl("https://gitlab.com/myorg/myrepo");
    expect(result).toEqual({ projectPath: "myorg/myrepo", repo: "myrepo" });
  });

  it("parses https://gitlab.com/group/repo.git", () => {
    const result = parseGitLabUrl("https://gitlab.com/acme/widgets.git");
    expect(result).toEqual({ projectPath: "acme/widgets", repo: "widgets" });
  });

  it("parses https://gitlab.com/group/subgroup/repo.git (nested groups)", () => {
    const result = parseGitLabUrl("https://gitlab.com/acme/frontend/widgets.git");
    expect(result).toEqual({ projectPath: "acme/frontend/widgets", repo: "widgets" });
  });

  it("parses git@gitlab.com:group/repo.git (SSH)", () => {
    const result = parseGitLabUrl("git@gitlab.com:acme/widgets.git");
    expect(result).toEqual({ projectPath: "acme/widgets", repo: "widgets" });
  });

  it("parses self-hosted GitLab HTTPS URL", () => {
    const result = parseGitLabUrl("https://gitlab.example.com/myorg/myrepo.git");
    expect(result).toEqual({ projectPath: "myorg/myrepo", repo: "myrepo" });
  });

  it("throws for invalid URL", () => {
    expect(() => parseGitLabUrl("")).toThrow("Unable to parse GitLab repo URL");
  });
});

describe("buildAuthenticatedUrl", () => {
  const config = { token: "glpat-xxxx" };

  it("injects credentials into a plain HTTPS URL", () => {
    const result = buildAuthenticatedUrl("https://gitlab.com/myorg/myrepo.git", config);
    expect(result).toContain("oauth2:glpat-xxxx@gitlab.com");
  });

  it("uses custom tokenUser when provided", () => {
    const result = buildAuthenticatedUrl(
      "https://gitlab.com/myorg/myrepo.git",
      config,
      "deploy-token-name",
    );
    expect(result).toContain("deploy-token-name:glpat-xxxx@gitlab.com");
  });

  it("does not overwrite existing credentials in URL", () => {
    const url = "https://user:pass@gitlab.com/myorg/myrepo.git";
    const result = buildAuthenticatedUrl(url, config);
    expect(result).toContain("user:pass@gitlab.com");
    expect(result).not.toContain("oauth2");
  });
});

describe("cleanupWorktrees", () => {
  it("returns empty array when baseDir does not exist", async () => {
    const result = await cleanupWorktrees("/tmp/nonexistent-dir-that-should-not-exist-xyz", 24);
    expect(result).toEqual([]);
  });

  it("removes directories older than the TTL", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "laf-cleanup-"));
    try {
      // Create a run directory that is "old"
      const oldRunDir = join(baseDir, "old-run");
      mkdirSync(join(oldRunDir, "worktree"), { recursive: true });
      // Set mtime to 48 hours ago
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      utimesSync(oldRunDir, oldTime, oldTime);

      // Create a run directory that is "new"
      const newRunDir = join(baseDir, "new-run");
      mkdirSync(join(newRunDir, "worktree"), { recursive: true });
      // mtime defaults to now — leave it alone

      const removed = await cleanupWorktrees(baseDir, 24);

      expect(removed).toHaveLength(1);
      expect(removed[0]).toBe(oldRunDir);

      // old directory should be gone, new one should remain
      expect(() => mkdirSync(newRunDir)).toThrow(); // still exists
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("does not remove directories younger than the TTL", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "laf-cleanup-young-"));
    try {
      const runDir = join(baseDir, "recent-run");
      mkdirSync(join(runDir, "worktree"), { recursive: true });

      const removed = await cleanupWorktrees(baseDir, 24);
      expect(removed).toHaveLength(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("git integration", () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "laf-src-"));
  const cloneDir = join(mkdtempSync(join(tmpdir(), "laf-clone-")), "repo");

  afterAll(() => {
    rmSync(sourceDir, { recursive: true, force: true });
    rmSync(join(cloneDir, ".."), { recursive: true, force: true });
  });

  it("clone and fetchLatest work with a local bare repo", async () => {
    // Init a bare repo as source
    execFileSync("git", ["init", "--bare", sourceDir]);

    // Create a temporary working copy to make an initial commit
    const workDir = mkdtempSync(join(tmpdir(), "laf-work-"));
    execFileSync("git", ["clone", sourceDir, workDir]);
    execFileSync("git", ["-C", workDir, "config", "user.email", "test@test.com"]);
    execFileSync("git", ["-C", workDir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", workDir, "commit", "--allow-empty", "-m", "init"]);
    execFileSync("git", ["-C", workDir, "push", "origin", "master"]);
    rmSync(workDir, { recursive: true, force: true });

    // Clone via our function
    await cloneRepo(sourceDir, cloneDir);

    // Verify it cloned
    const remote = execFileSync("git", ["-C", cloneDir, "remote", "get-url", "origin"])
      .toString()
      .trim();
    expect(remote).toBe(sourceDir);

    // fetchLatest should not throw
    await fetchLatest(cloneDir);

    // Calling cloneRepo again on the same dir should just fetch (not error)
    await cloneRepo(sourceDir, cloneDir);
  });
});

// ---------------------------------------------------------------------------
// rebaseBranch / abortRebase integration tests
// ---------------------------------------------------------------------------
describe("rebaseBranch / abortRebase", () => {
  /**
   * Set up a fresh local "origin" bare repo + a clone for each test.
   * Origin's HEAD is set to `main` before the first push so that
   * subsequent clones check out `main` automatically.
   */
  function makeRepo() {
    const origin = mkdtempSync(join(tmpdir(), "laf-rebase-origin-"));
    const clone = mkdtempSync(join(tmpdir(), "laf-rebase-clone-"));

    // Bare repo with `main` as default branch
    execFileSync("git", ["init", "--bare", origin]);
    execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    execFileSync("git", ["clone", origin, clone]);

    const gc = (args: string[], opts?: { cwd?: string }) =>
      execFileSync("git", ["-C", opts?.cwd ?? clone, ...args], { encoding: "utf8" });

    gc(["config", "user.email", "test@test.com"]);
    gc(["config", "user.name", "Test"]);

    // Initial commit on main
    writeFileSync(join(clone, "file.txt"), "initial\n");
    gc(["add", "file.txt"]);
    gc(["commit", "-m", "init"]);
    gc(["branch", "-M", "main"]);
    gc(["push", "-u", "origin", "main"]);

    return { origin, clone, gc };
  }

  /** Push a new commit to origin/main using a temporary working copy. */
  function advanceMain(origin: string, filename: string, content: string, message: string) {
    const workDir = mkdtempSync(join(tmpdir(), "laf-rebase-adv-"));
    try {
      execFileSync("git", ["clone", origin, workDir]);
      execFileSync("git", ["-C", workDir, "config", "user.email", "test@test.com"]);
      execFileSync("git", ["-C", workDir, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", workDir, "checkout", "main"]);
      writeFileSync(join(workDir, filename), content);
      execFileSync("git", ["-C", workDir, "add", filename]);
      execFileSync("git", ["-C", workDir, "commit", "-m", message]);
      execFileSync("git", ["-C", workDir, "push", "origin", "main"]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  it("succeeds (no conflicts) when the base branch has new commits", async () => {
    const { origin, clone, gc } = makeRepo();

    try {
      // Create a feature branch with a commit touching a different file
      gc(["checkout", "-b", "feature"]);
      writeFileSync(join(clone, "feature.txt"), "feature work\n");
      gc(["add", "feature.txt"]);
      gc(["commit", "-m", "add feature"]);

      // Advance origin/main with an unrelated change
      advanceMain(origin, "other.txt", "other change\n", "advance main");

      // Rebase should succeed — no conflicting edits
      const result = await rebaseBranch(clone, "main");
      expect(result.success).toBe(true);
      expect(result.hasConflicts).toBe(false);

      // Feature commit should still be present after rebase
      const log = gc(["log", "--oneline"]);
      expect(log).toContain("add feature");
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("returns success:false when there are conflicts, and abortRebase cleans up", async () => {
    const { origin, clone, gc } = makeRepo();

    try {
      // Create a feature branch that modifies file.txt
      gc(["checkout", "-b", "conflict-branch"]);
      writeFileSync(join(clone, "file.txt"), "feature version\n");
      gc(["add", "file.txt"]);
      gc(["commit", "-m", "feature changes file.txt"]);

      // Advance origin/main with a conflicting edit to the same file
      advanceMain(origin, "file.txt", "main version\n", "main changes same file");

      // Rebase should fail due to conflict
      const result = await rebaseBranch(clone, "main");
      expect(result.success).toBe(false);
      expect(result.hasConflicts).toBe(true);

      // abortRebase should restore the working tree cleanly
      await abortRebase(clone);
      const status = gc(["status", "--porcelain"]);
      expect(status.trim()).toBe("");
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("abortRebase is safe to call when no rebase is in progress", async () => {
    const { origin, clone } = makeRepo();
    try {
      // Should not throw even though no rebase is active (gitExecSafe swallows the error)
      await expect(abortRebase(clone)).resolves.toBeUndefined();
    } finally {
      rmSync(origin, { recursive: true, force: true });
      rmSync(clone, { recursive: true, force: true });
    }
  });
});
