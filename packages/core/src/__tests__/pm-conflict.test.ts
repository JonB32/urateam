import { describe, it, expect, vi, beforeEach } from "vitest";
import { getActiveFileMaps, predictConflict } from "../pm/conflict.js";

// Capture log spies so tests can assert on them without parsing log output.
// vi.hoisted ensures the mock factory runs before the module imports above.
const { mockLogWarn, mockLogDebug } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogDebug: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: mockLogDebug,
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
  })),
}));

describe("getActiveFileMaps", () => {
  beforeEach(() => { mockLogWarn.mockClear(); mockLogDebug.mockClear(); });

  it("builds file map from git diff output for pushed branch", async () => {
    const execGit = vi.fn()
      .mockResolvedValueOnce("") // fetch
      .mockResolvedValueOnce("abc123") // rev-parse: branch exists on origin
      .mockResolvedValueOnce("src/auth/login.ts\nsrc/auth/session.ts\n"); // diff
    const activeRuns = [
      { issueId: "BEC-10", branch: "fix/bec-10-login" },
    ];

    const fileMaps = await getActiveFileMaps({
      activeRuns,
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    expect(fileMaps.get("BEC-10")).toEqual(new Set(["src/auth/login.ts", "src/auth/session.ts"]));
    expect(execGit).toHaveBeenCalledWith(
      ["diff", "--name-only", "origin/main..origin/fix/bec-10-login"],
      "/tmp/repo",
    );
  });

  it("returns empty set on git diff failure for pushed branch", async () => {
    const execGit = vi.fn()
      .mockResolvedValueOnce("") // fetch
      .mockResolvedValueOnce("abc123") // rev-parse: branch exists on origin
      .mockRejectedValueOnce(new Error("diff failed unexpectedly")); // diff throws
    const activeRuns = [
      { issueId: "BEC-11", branch: "fix/bec-11-signup" },
    ];

    const fileMaps = await getActiveFileMaps({
      activeRuns,
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    expect(fileMaps.get("BEC-11")).toEqual(new Set());
  });

  it("returns empty map when no active runs", async () => {
    const execGit = vi.fn();
    const fileMaps = await getActiveFileMaps({
      activeRuns: [],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });
    expect(fileMaps.size).toBe(0);
    expect(execGit).not.toHaveBeenCalled();
  });

  // BEC-239 — AC (a): run with no remote branch uses worktree diff instead
  it("(a) run not yet pushed: uses worktree diff and returns in-progress files", async () => {
    const execGit = vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === "fetch") return "";
      // rev-parse fails — branch not on origin yet
      if (args[0] === "rev-parse") throw new Error("unknown revision");
      // committed files from worktree diff
      if (args[0] === "diff" && cwd === "/tmp/runs/run-1/worktree") {
        return "packages/core/src/pm/conflict.ts\npackages/core/src/pm/scheduler.ts\n";
      }
      // uncommitted files from worktree status
      if (args[0] === "status" && cwd === "/tmp/runs/run-1/worktree") {
        return " M packages/core/src/pm/types.ts\n?? packages/core/src/pm/new-file.ts\n";
      }
      return "";
    });

    const fileMaps = await getActiveFileMaps({
      activeRuns: [
        { issueId: "BEC-238", branch: "agent/BEC-238-slack-bot-token", worktreePath: "/tmp/runs/run-1/worktree" },
      ],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
      pathExists: () => true,
    });

    const files = fileMaps.get("BEC-238")!;
    expect(files).toBeDefined();
    // Committed changes
    expect(files.has("packages/core/src/pm/conflict.ts")).toBe(true);
    expect(files.has("packages/core/src/pm/scheduler.ts")).toBe(true);
    // Uncommitted changes
    expect(files.has("packages/core/src/pm/types.ts")).toBe(true);
    expect(files.has("packages/core/src/pm/new-file.ts")).toBe(true);
    // origin diff must NOT have been called (branch not on origin)
    const originDiffCalls = execGit.mock.calls.filter(
      ([a]) => a[0] === "diff" && (a[2] as string | undefined)?.startsWith("origin/main..origin/"),
    );
    expect(originDiffCalls).toHaveLength(0);
  });

  // BEC-239 — AC (b): pushed branch still uses origin diff path unchanged
  it("(b) pushed branch: uses origin diff path, not worktree", async () => {
    const execGit = vi.fn(async (args: string[], _cwd: string) => {
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse") return "deadbeef"; // branch IS on origin
      if (args[0] === "diff") return "src/foo.ts\nsrc/bar.ts\n";
      return "";
    });

    const fileMaps = await getActiveFileMaps({
      activeRuns: [
        { issueId: "BEC-237", branch: "agent/BEC-237-feature", worktreePath: "/tmp/runs/run-2/worktree" },
      ],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    const files = fileMaps.get("BEC-237")!;
    expect(files).toEqual(new Set(["src/foo.ts", "src/bar.ts"]));
    // status must NOT have been called (worktree path not used for pushed runs)
    const statusCalls = execGit.mock.calls.filter(([a]) => a[0] === "status");
    expect(statusCalls).toHaveLength(0);
    // origin diff must have been called
    const diffArgs = execGit.mock.calls.find(([a]) => a[0] === "diff")![0];
    expect(diffArgs[2]).toBe("origin/main..origin/agent/BEC-237-feature");
  });

  // BEC-239 — AC (c): genuine git error on pushed run → empty set + warn-level log
  it("(c) genuine git error on pushed run → empty set, warn logged", async () => {
    const execGit = vi.fn(async (args: string[]) => {
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse") return "abc123"; // branch IS on origin
      throw new Error("internal git corruption"); // genuine diff failure
    });

    const fileMaps = await getActiveFileMaps({
      activeRuns: [{ issueId: "BEC-99", branch: "agent/BEC-99-real-error" }],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    // Fail open — empty set returned, no throw
    expect(fileMaps.get("BEC-99")).toEqual(new Set());

    // The genuine diff failure must be logged at warn (not swallowed silently)
    expect(mockLogWarn).toHaveBeenCalledOnce();
    const [logObj, logMsg] = mockLogWarn.mock.calls[0];
    expect(logMsg).toBe("git diff failed, treating as empty");
    expect(logObj).toMatchObject({ issueId: "BEC-99", branch: "agent/BEC-99-real-error" });
    expect(logObj.err).toBeInstanceOf(Error);
  });

  // BEC-239 — fail-open: worktree also unreadable → empty set, no throw
  it("run not pushed and worktree unreadable → fail open with empty set", async () => {
    const execGit = vi.fn(async (args: string[]) => {
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse") throw new Error("unknown revision"); // not on origin
      throw new Error("worktree missing"); // both diff and status fail
    });

    const fileMaps = await getActiveFileMaps({
      activeRuns: [
        { issueId: "BEC-240", branch: "agent/BEC-240-gone", worktreePath: "/tmp/runs/gone/worktree" },
      ],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    expect(fileMaps.get("BEC-240")).toEqual(new Set());
  });

  // BEC-247 — worktree path set but directory doesn't exist on disk
  it("(BEC-247) non-existent worktreePath → empty set, no warn, execGit never called for that path", async () => {
    const nonExistentPath = `/tmp/this-does-not-exist-${Date.now()}`;
    const execGit = vi.fn(async (args: string[], _cwd: string) => {
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse") throw new Error("unknown revision"); // not on origin
      // execGit must never be called against the non-existent path
      throw new Error("should not have been called");
    });

    const fileMaps = await getActiveFileMaps({
      activeRuns: [
        { issueId: "BEC-247", branch: "agent/BEC-247-repro", worktreePath: nonExistentPath },
      ],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    // Fail-open: returns empty set
    expect(fileMaps.get("BEC-247")).toEqual(new Set());

    // execGit must NOT have been called against the non-existent worktree path
    const worktreeCalls = execGit.mock.calls.filter(([_args, cwd]) => cwd === nonExistentPath);
    expect(worktreeCalls).toHaveLength(0);

    // No warn-level log — missing worktree is expected/normal, not an error
    expect(mockLogWarn).not.toHaveBeenCalled();

    // A debug-level message should explain why the worktree was skipped
    const debugCalls = mockLogDebug.mock.calls.filter(([obj]) =>
      typeof obj === "object" && obj !== null && "worktreePath" in obj && obj.worktreePath === nonExistentPath,
    );
    expect(debugCalls.length).toBeGreaterThan(0);
    expect(debugCalls[0][1]).toContain("worktree not yet created");
  });

  // BEC-239 — no worktreePath on ActiveRun → empty set (graceful missing-path case)
  it("run not pushed and no worktreePath → empty set", async () => {
    const execGit = vi.fn(async (args: string[]) => {
      if (args[0] === "fetch") return "";
      if (args[0] === "rev-parse") throw new Error("unknown revision");
      return "";
    });

    const fileMaps = await getActiveFileMaps({
      activeRuns: [{ issueId: "BEC-241", branch: "agent/BEC-241-no-path" }],
      defaultBranch: "main",
      repoDir: "/tmp/repo",
      execGit,
    });

    expect(fileMaps.get("BEC-241")).toEqual(new Set());
  });
});

describe("predictConflict", () => {
  it("returns none when no active files overlap", async () => {
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({ likelyFiles: ["src/api/routes.ts"], overlapRisk: "none", reasoning: "different area" }),
    );
    const result = await predictConflict({
      candidateDescription: "Add API routes for users",
      activeFileMaps: new Map([["BEC-10", new Set(["src/auth/login.ts"])]]),
      callClaude,
    });
    expect(result.overlapRisk).toBe("none");
  });

  it("returns high when Claude predicts overlap", async () => {
    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({ likelyFiles: ["src/auth/login.ts"], overlapRisk: "high", reasoning: "both touch auth" }),
    );
    const result = await predictConflict({
      candidateDescription: "Fix auth flow",
      activeFileMaps: new Map([["BEC-10", new Set(["src/auth/login.ts"])]]),
      callClaude,
    });
    expect(result.overlapRisk).toBe("high");
    expect(result.reasoning).toContain("auth");
  });

  it("returns none when no active runs have files", async () => {
    const callClaude = vi.fn();
    const result = await predictConflict({
      candidateDescription: "Add feature",
      activeFileMaps: new Map(),
      callClaude,
    });
    expect(result.overlapRisk).toBe("none");
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("returns low on invalid Claude JSON", async () => {
    const callClaude = vi.fn().mockResolvedValue("not json");
    const result = await predictConflict({
      candidateDescription: "Some work",
      activeFileMaps: new Map([["BEC-10", new Set(["src/file.ts"])]]),
      callClaude,
    });
    expect(result.overlapRisk).toBe("low");
  });
});
