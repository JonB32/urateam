import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scaffold } from "../index.js";

describe("scaffold — sidecar pattern", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "create-urateam-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const baseOptions = (projectDir: string, projectName: string) => ({
    projectDir,
    projectName,
    linearApiKey: "lin_api_test",
    linearTeamId: "team-123",
    repoUrl: "https://github.com/user/repo",
    defaultBranch: "main",
  });

  describe("new project (empty target directory)", () => {
    it("creates .urateam/ with all sidecar template files", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      expect(existsSync(join(projectDir, ".urateam"))).toBe(true);
      expect(existsSync(join(projectDir, ".urateam", "package.json"))).toBe(true);
      expect(existsSync(join(projectDir, ".urateam", ".env"))).toBe(true);
      expect(existsSync(join(projectDir, ".urateam", ".env.example"))).toBe(true);
      expect(existsSync(join(projectDir, ".urateam", "docker-compose.yml"))).toBe(true);
      expect(existsSync(join(projectDir, ".urateam", "Dockerfile"))).toBe(true);
      expect(existsSync(join(projectDir, ".urateam", "README.md"))).toBe(true);
    });

    it("does NOT create a package.json at the project root", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      expect(existsSync(join(projectDir, "package.json"))).toBe(false);
    });

    it("creates CLAUDE.md at the project root with project name", () => {
      const projectDir = join(tempDir, "cool-agent");
      scaffold(baseOptions(projectDir, "cool-agent"));

      const claudeMdPath = join(projectDir, "CLAUDE.md");
      expect(existsSync(claudeMdPath)).toBe(true);

      const content = readFileSync(claudeMdPath, "utf-8");
      expect(content).toContain("# cool-agent");
      expect(content).not.toContain("{{PROJECT_NAME}}");
      expect(content).toContain("urateam sidecar");
    });

    it("creates .gitignore with .urateam/.env entry", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      const gitignorePath = join(projectDir, ".gitignore");
      expect(existsSync(gitignorePath)).toBe(true);

      const content = readFileSync(gitignorePath, "utf-8");
      expect(content).toContain(".urateam/.env");
      expect(content).toContain(".urateam/node_modules/");
    });

    it(".urateam/package.json has sidecar name and @urateam/cli dependency", () => {
      const projectDir = join(tempDir, "cool-agent");
      scaffold(baseOptions(projectDir, "cool-agent"));

      const pkg = JSON.parse(readFileSync(join(projectDir, ".urateam", "package.json"), "utf-8"));
      expect(pkg.name).toBe("cool-agent-urateam");
      expect(pkg.dependencies["@urateam/cli"]).toBeDefined();
      expect(pkg.scripts.dev).toBe("ura dev");
      expect(pkg.scripts.start).toBe("ura start");
    });

    it(".urateam/.env has provided credentials", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold({
        projectDir,
        projectName: "my-project",
        linearApiKey: "lin_api_abc123",
        linearTeamId: "team-xyz",
        repoUrl: "https://github.com/org/mobile-app",
        defaultBranch: "develop",
      });

      const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
      expect(env).toContain("LINEAR_API_KEY=lin_api_abc123");
      expect(env).toContain("LINEAR_TEAM_ID=team-xyz");
      expect(env).toContain("REPO_URL=https://github.com/org/mobile-app");
      expect(env).toContain("REPO_DEFAULT_BRANCH=develop");
      expect(env).toContain("REPO_TEAM_ID=team-xyz");
    });

    it(".urateam/.env has a random DASHBOARD_PASSWORD", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
      const match = env.match(/DASHBOARD_PASSWORD=([a-f0-9]+)/);
      expect(match).not.toBeNull();
      expect(match![1].length).toBeGreaterThanOrEqual(32);
    });

    it("creates README.md at project root with project name", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      const readmePath = join(projectDir, "README.md");
      expect(existsSync(readmePath)).toBe(true);

      const content = readFileSync(readmePath, "utf-8");
      expect(content).toContain("# my-project");
      expect(content).not.toContain("{{PROJECT_NAME}}");
    });

    it(".gitignore has .env.* wildcard with example exception", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      expect(content).toContain(".urateam/.env.*");
      expect(content).toContain("!.urateam/.env.example");
    });

    it(".gitignore content is inlined (not loaded from template file)", () => {
      // Regression test: npm publish excludes files named `.gitignore` from
      // tarballs automatically, so if the scaffold were to read it from disk,
      // it would fail with ENOENT when installed from npm. This test verifies
      // that the scaffold works regardless of whether template/.gitignore
      // exists on disk.
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      expect(content).toContain("# urateam sidecar");
      expect(content).toContain(".urateam/.env");
      expect(content).toContain(".urateam/node_modules/");
    });
  });

  describe("existing project (directory with files already)", () => {
    it("preserves existing CLAUDE.md at project root", () => {
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      const existingContent = "# My Existing Project\n\nCustom content that should be preserved.\n";
      writeFileSync(join(projectDir, "CLAUDE.md"), existingContent);

      scaffold(baseOptions(projectDir, "existing-project"));

      const finalContent = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
      expect(finalContent).toBe(existingContent);
    });

    it("preserves existing README.md at project root", () => {
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      const existingContent = "# My App\n\nProduction-ready.\n";
      writeFileSync(join(projectDir, "README.md"), existingContent);

      scaffold(baseOptions(projectDir, "existing-project"));

      const finalContent = readFileSync(join(projectDir, "README.md"), "utf-8");
      expect(finalContent).toBe(existingContent);
    });

    it("treats !.urateam/.env.example as not-yet-ignored (bare entry check)", () => {
      // Regression test: loose substring matching of ".urateam/.env" would
      // false-positive on "!.urateam/.env.example" and skip the append.
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, ".gitignore"),
        "node_modules/\n!.urateam/.env.example\n",
      );

      scaffold(baseOptions(projectDir, "existing-project"));

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      // Should still append the bare .urateam/.env entry
      const lines = content.split("\n").map((l) => l.trim());
      expect(lines).toContain(".urateam/.env");
    });

    it("preserves existing package.json at project root", () => {
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      const existingPkg = { name: "my-app", version: "1.0.0", dependencies: { react: "^19.0.0" } };
      writeFileSync(join(projectDir, "package.json"), JSON.stringify(existingPkg, null, 2));

      scaffold(baseOptions(projectDir, "existing-project"));

      const finalPkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
      expect(finalPkg.name).toBe("my-app");
      expect(finalPkg.dependencies.react).toBe("^19.0.0");
      expect(finalPkg.dependencies["@urateam/cli"]).toBeUndefined();
    });

    it("appends .urateam/.env to existing .gitignore without duplication", () => {
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, ".gitignore"), "node_modules/\ndist/\n");

      scaffold(baseOptions(projectDir, "existing-project"));

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      expect(content).toContain("node_modules/");
      expect(content).toContain("dist/");
      expect(content).toContain(".urateam/.env");
    });

    it("does NOT duplicate .urateam/.env entry if already present", () => {
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n.urateam/.env\n");

      scaffold(baseOptions(projectDir, "existing-project"));

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      const matches = content.match(/\.urateam\/\.env/g);
      expect(matches?.length).toBe(1);
    });

    it("still creates .urateam/ sidecar in existing project", () => {
      const projectDir = join(tempDir, "existing-project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "README.md"), "# My App");
      writeFileSync(join(projectDir, "package.json"), '{"name":"my-app"}');

      scaffold(baseOptions(projectDir, "existing-project"));

      expect(existsSync(join(projectDir, ".urateam", "package.json"))).toBe(true);
      expect(existsSync(join(projectDir, ".urateam", ".env"))).toBe(true);
    });
  });
});
