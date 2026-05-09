import { describe, it, expect } from "vitest";
import { selectRepoConfig } from "../pm/actions/select-repo-config.js";
import type { RepoConfig } from "../types.js";

function makeRepo(url: string, labelPattern?: string): RepoConfig {
  const config: RepoConfig = {
    url,
    defaultBranch: "main",
    testCommand: "pnpm test",
    buildCommand: "pnpm build",
  };
  if (labelPattern !== undefined) {
    config.labelPattern = labelPattern;
  }
  return config;
}

describe("selectRepoConfig (BEC-177)", () => {
  describe("label-pattern lookup", () => {
    it("returns the config whose labelPattern matches the pipeline label", () => {
      const repoConfigs = {
        "team-abc": makeRepo("https://github.com/JonB32/urateam"),
        "observer": makeRepo("https://github.com/JonB32/urateam-quality-observer", "observer-fix"),
      };

      const result = selectRepoConfig("observer-fix", "team-abc", null, repoConfigs);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://github.com/JonB32/urateam-quality-observer");
    });

    it("is case-insensitive for labelPattern matching", () => {
      const repoConfigs = {
        "observer": makeRepo("https://github.com/JonB32/urateam-quality-observer", "Observer-Fix"),
      };

      const result = selectRepoConfig("observer-fix", null, null, repoConfigs);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://github.com/JonB32/urateam-quality-observer");
    });

    it("is case-insensitive for pipeline label (uppercased label)", () => {
      const repoConfigs = {
        "observer": makeRepo("https://github.com/JonB32/urateam-quality-observer", "observer-fix"),
      };

      const result = selectRepoConfig("OBSERVER-FIX", null, null, repoConfigs);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://github.com/JonB32/urateam-quality-observer");
    });

    it("label-pattern match takes priority over teamId key lookup", () => {
      // Even though teamId matches a key, the labelPattern takes priority
      const repoConfigs = {
        "team-abc": makeRepo("https://github.com/JonB32/urateam"),
        "observer": makeRepo("https://github.com/JonB32/urateam-quality-observer", "observer-fix"),
      };

      // team-abc matches by teamId key, observer matches by labelPattern
      const result = selectRepoConfig("observer-fix", "team-abc", null, repoConfigs);

      expect(result!.url).toBe("https://github.com/JonB32/urateam-quality-observer");
    });
  });

  describe("teamId fallback (backwards compatibility)", () => {
    it("falls back to teamId key lookup when no labelPattern matches", () => {
      const repoConfigs = {
        "team-abc": makeRepo("https://github.com/JonB32/urateam"),
      };

      const result = selectRepoConfig("auto-implement", "team-abc", null, repoConfigs);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://github.com/JonB32/urateam");
    });

    it("falls back to projectId key lookup when teamId key is missing", () => {
      const repoConfigs = {
        "proj-xyz": makeRepo("https://github.com/JonB32/urateam"),
      };

      const result = selectRepoConfig("auto-implement", "unknown-team", "proj-xyz", repoConfigs);

      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://github.com/JonB32/urateam");
    });

    it("returns null when no teamId, projectId, or matching labelPattern found", () => {
      const repoConfigs = {
        "team-abc": makeRepo("https://github.com/JonB32/urateam"),
      };

      const result = selectRepoConfig("auto-implement", "unknown-team", "unknown-proj", repoConfigs);

      expect(result).toBeNull();
    });

    it("returns null for empty repoConfigs", () => {
      const result = selectRepoConfig("auto-implement", "team-abc", null, {});
      expect(result).toBeNull();
    });
  });

  describe("graceful handling of missing labelPattern", () => {
    it("skips entries without labelPattern during label scan", () => {
      const repoConfigs = {
        "team-abc": makeRepo("https://github.com/JonB32/urateam"), // no labelPattern
        "team-def": makeRepo("https://github.com/JonB32/other"),   // no labelPattern
      };

      // Falls back to teamId lookup, ignoring entries without labelPattern
      const result = selectRepoConfig("auto-implement", "team-abc", null, repoConfigs);

      expect(result!.url).toBe("https://github.com/JonB32/urateam");
    });

    it("handles null teamId and projectId gracefully with no labelPattern match", () => {
      const repoConfigs = {
        "team-abc": makeRepo("https://github.com/JonB32/urateam"),
      };

      const result = selectRepoConfig("auto-implement", null, null, repoConfigs);
      expect(result).toBeNull();
    });

    it("handles undefined teamId and projectId gracefully", () => {
      const repoConfigs = {
        "team-abc": makeRepo("https://github.com/JonB32/urateam"),
      };

      const result = selectRepoConfig("auto-implement", undefined, undefined, repoConfigs);
      expect(result).toBeNull();
    });
  });

  describe("multi-repo routing integration scenario", () => {
    it("routes auto-implement to urateam and observer-fix to observer repo", () => {
      // Two repoConfigs: auto-implement → urateam, observer-fix → observer-repo
      const repoConfigs: Record<string, RepoConfig> = {
        "team-main": makeRepo("https://github.com/JonB32/urateam", "auto-implement"),
        "team-observer": makeRepo("https://github.com/JonB32/urateam-quality-observer", "observer-fix"),
      };

      // Ticket with observer-fix label → observer repo
      const observerResult = selectRepoConfig("observer-fix", "team-main", null, repoConfigs);
      expect(observerResult!.url).toBe("https://github.com/JonB32/urateam-quality-observer");

      // Ticket with auto-implement label → urateam
      const mainResult = selectRepoConfig("auto-implement", "team-main", null, repoConfigs);
      expect(mainResult!.url).toBe("https://github.com/JonB32/urateam");
    });

    it("falls back to auto-implement config for unmapped labels via teamId", () => {
      // Legacy config: no labelPattern, relies on teamId key
      const repoConfigs: Record<string, RepoConfig> = {
        "team-main": makeRepo("https://github.com/JonB32/urateam"),
      };

      // Any label that resolves to a pipeline key routes via teamId fallback
      const result = selectRepoConfig("auto-implement", "team-main", null, repoConfigs);
      expect(result!.url).toBe("https://github.com/JonB32/urateam");
    });
  });
});
