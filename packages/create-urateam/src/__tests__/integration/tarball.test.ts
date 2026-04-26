import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

/**
 * End-to-end packaging test for create-urateam.
 *
 * 1. `pnpm pack` the package into a tarball
 * 2. `npm install <tarball>` into a clean temp directory
 * 3. Import scaffold() from the installed copy and run it against a scratch dir
 * 4. Assert all expected files exist (sidecar, project root, .gitignore)
 *
 * Regression guard for the 0.1.4 ENOENT .gitignore crash: npm publish
 * automatically excludes files literally named `.gitignore` from tarballs,
 * which broke `create-urateam` when it tried to read `template/.gitignore`
 * at runtime. This test would have caught that before publish.
 *
 * We import scaffold() directly rather than spawning the bin shim because
 * the bin uses interactive `prompts`, which doesn't compose with piped
 * stdin in the test runner. Importing from the installed dist/ exercises
 * the same code path (template resolution + .gitignore inlining) that
 * crashed in 0.1.4 — the publishing concern this test guards against.
 */

const PACKAGE_DIR = resolve(__dirname, "..", "..", "..");

interface ScaffoldFn {
  (opts: {
    projectDir: string;
    projectName: string;
    linearApiKey: string;
    linearTeamId: string;
    repoUrl: string;
    defaultBranch: string;
  }): void;
}

describe("create-urateam — installed tarball", () => {
  let workRoot: string;
  let tarballPath: string;
  let installRoot: string;
  let installedScaffold: ScaffoldFn;

  beforeAll(async () => {
    workRoot = mkdtempSync(join(tmpdir(), "create-urateam-tarball-"));

    // 1. Pack
    execFileSync("pnpm", ["pack", "--pack-destination", workRoot], {
      cwd: PACKAGE_DIR,
      stdio: "pipe",
    });

    const tgz = readdirSync(workRoot).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack produced no .tgz file");
    tarballPath = join(workRoot, tgz);

    // 2. Install into a clean tree
    installRoot = join(workRoot, "install");
    mkdirSync(installRoot, { recursive: true });
    execFileSync("npm", ["init", "-y"], { cwd: installRoot, stdio: "pipe" });
    execFileSync("npm", ["install", tarballPath], {
      cwd: installRoot,
      stdio: "pipe",
    });

    // 3. Dynamically import scaffold() from the installed copy
    const installedDist = join(
      installRoot,
      "node_modules",
      "create-urateam",
      "dist",
      "index.js",
    );
    const mod = (await import(pathToFileURL(installedDist).href)) as {
      scaffold: ScaffoldFn;
    };
    installedScaffold = mod.scaffold;
  }, 120_000);

  afterAll(() => {
    if (workRoot) rmSync(workRoot, { recursive: true, force: true });
  });

  it("packs and installs without errors", () => {
    expect(existsSync(tarballPath)).toBe(true);
    expect(existsSync(join(installRoot, "node_modules", "create-urateam"))).toBe(true);
  });

  it("installed package contains dist/ and template/", () => {
    const installedRoot = join(installRoot, "node_modules", "create-urateam");
    expect(existsSync(join(installedRoot, "dist", "index.js"))).toBe(true);
    expect(existsSync(join(installedRoot, "template"))).toBe(true);
    expect(existsSync(join(installedRoot, "template", ".urateam"))).toBe(true);
  });

  it("exposes scaffold() from the installed dist/ entry", () => {
    expect(typeof installedScaffold).toBe("function");
  });

  it("scaffolds a fresh project from the installed package", () => {
    const projectDir = join(workRoot, "scratch-project");
    installedScaffold({
      projectDir,
      projectName: "scratch-project",
      linearApiKey: "lin_api_test",
      linearTeamId: "team-test",
      repoUrl: "https://github.com/test/repo",
      defaultBranch: "main",
    });

    // Sidecar files
    expect(existsSync(join(projectDir, ".urateam", "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".urateam", ".env"))).toBe(true);
    expect(existsSync(join(projectDir, ".urateam", "Dockerfile"))).toBe(true);
    expect(existsSync(join(projectDir, ".urateam", "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(projectDir, ".urateam", "README.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".urateam", ".npmrc"))).toBe(true);

    // Project root files
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(projectDir, "README.md"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
  });

  it(".npmrc from installed copy has ignore-workspace=true (regression guard for urateam#31)", () => {
    const projectDir = join(workRoot, "npmrc-check");
    installedScaffold({
      projectDir,
      projectName: "npmrc-check",
      linearApiKey: "lin_api_test",
      linearTeamId: "team-test",
      repoUrl: "https://github.com/test/repo",
      defaultBranch: "main",
    });

    // npm publish strips files literally named `.npmrc` from tarballs by
    // default, the same way it strips `.gitignore`. Inlining the content
    // (URATEAM_NPMRC in src/index.ts) sidesteps that — this test fails
    // if anyone reverts to shipping the file through template/.urateam/.
    const npmrc = readFileSync(join(projectDir, ".urateam", ".npmrc"), "utf-8");
    expect(npmrc).toContain("ignore-workspace=true");
  });

  it(".gitignore from installed copy has urateam entries (regression guard for 0.1.4 ENOENT)", () => {
    const projectDir = join(workRoot, "gitignore-check");
    installedScaffold({
      projectDir,
      projectName: "gitignore-check",
      linearApiKey: "lin_api_test",
      linearTeamId: "team-test",
      repoUrl: "https://github.com/test/repo",
      defaultBranch: "main",
    });

    const gitignore = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(gitignore).toContain("# urateam sidecar");
    expect(gitignore).toContain(".urateam/.env");
    expect(gitignore).toContain(".urateam/.env.*");
    expect(gitignore).toContain("!.urateam/.env.example");
    expect(gitignore).toContain(".urateam/node_modules/");
  });
});
