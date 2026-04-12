import { describe, it, expect, vi } from "vitest";
import { getActiveFileMaps, predictConflict } from "../pm/conflict.js";

describe("getActiveFileMaps", () => {
  it("builds file map from git diff output", async () => {
    const execGit = vi.fn()
      .mockResolvedValueOnce("") // fetch
      .mockResolvedValueOnce("src/auth/login.ts\nsrc/auth/session.ts\n");
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

  it("returns empty set on git failure", async () => {
    const execGit = vi.fn()
      .mockResolvedValueOnce("") // fetch
      .mockRejectedValueOnce(new Error("branch not found"));
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
