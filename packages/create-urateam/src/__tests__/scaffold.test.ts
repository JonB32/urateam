import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scaffold } from "../index.js";

describe("scaffold", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "create-urateam-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates project directory with all template files", () => {
    const projectDir = join(tempDir, "my-project");
    scaffold({
      projectDir,
      projectName: "my-project",
      linearApiKey: "lin_api_test",
      linearTeamId: "team-123",
      repoUrl: "https://github.com/user/repo",
      defaultBranch: "main",
    });

    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".env"))).toBe(true);
    expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(join(projectDir, "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(projectDir, "Dockerfile"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
    expect(existsSync(join(projectDir, "README.md"))).toBe(true);
  });

  it("writes .env with provided values", () => {
    const projectDir = join(tempDir, "my-project");
    scaffold({
      projectDir,
      projectName: "my-project",
      linearApiKey: "lin_api_test123",
      linearTeamId: "team-abc",
      repoUrl: "https://github.com/org/mobile-app",
      defaultBranch: "develop",
    });

    const env = readFileSync(join(projectDir, ".env"), "utf-8");
    expect(env).toContain("LINEAR_API_KEY=lin_api_test123");
    expect(env).toContain("LINEAR_TEAM_ID=team-abc");
    expect(env).toContain("REPO_URL=https://github.com/org/mobile-app");
    expect(env).toContain("REPO_DEFAULT_BRANCH=develop");
    expect(env).toContain("REPO_TEAM_ID=team-abc");
  });

  it("package.json uses project name and depends on @urateam/cli", () => {
    const projectDir = join(tempDir, "cool-agent");
    scaffold({
      projectDir,
      projectName: "cool-agent",
      linearApiKey: "key",
      linearTeamId: "team",
      repoUrl: "https://github.com/x/y",
      defaultBranch: "main",
    });

    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("cool-agent");
    expect(pkg.dependencies["@urateam/cli"]).toBeDefined();
  });

  it("README.md includes project name", () => {
    const projectDir = join(tempDir, "my-app");
    scaffold({
      projectDir,
      projectName: "my-app",
      linearApiKey: "key",
      linearTeamId: "team",
      repoUrl: "https://github.com/x/y",
      defaultBranch: "main",
    });

    const readme = readFileSync(join(projectDir, "README.md"), "utf-8");
    expect(readme).toContain("my-app");
    expect(readme).not.toContain("{{PROJECT_NAME}}");
  });

  it("copies .github/workflows/ci.yml", () => {
    const projectDir = join(tempDir, "ci-test");
    scaffold({
      projectDir,
      projectName: "ci-test",
      linearApiKey: "key",
      linearTeamId: "team",
      repoUrl: "https://github.com/x/y",
      defaultBranch: "main",
    });

    expect(existsSync(join(projectDir, ".github", "workflows", "ci.yml"))).toBe(true);
  });
});
