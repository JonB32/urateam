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
      expect(existsSync(join(projectDir, ".urateam", "Caddyfile"))).toBe(true);
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

    it("creates .urateam/pnpm-workspace.yaml (pnpm monorepo fix, urateam#31)", () => {
      const projectDir = join(tempDir, "my-project");
      scaffold(baseOptions(projectDir, "my-project"));

      const wsPath = join(projectDir, ".urateam", "pnpm-workspace.yaml");
      expect(existsSync(wsPath)).toBe(true);
      const content = readFileSync(wsPath, "utf-8");
      // Empty `packages:` list stops pnpm's upward workspace walk at .urateam/
      // so `pnpm install` installs the sidecar's own deps locally.
      expect(content).toContain("packages: []");
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
      // base64url-encoded 18 random bytes = 24 chars, no padding, no `+` or `/`
      const match = env.match(/DASHBOARD_PASSWORD=([A-Za-z0-9_-]+)/);
      expect(match).not.toBeNull();
      expect(match![1].length).toBeGreaterThanOrEqual(20);
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

  describe("re-run safety (running create-urateam twice)", () => {
    it("preserves existing .urateam/.env with real credentials", () => {
      const projectDir = join(tempDir, "rerun-project");
      scaffold(baseOptions(projectDir, "rerun-project"));

      // Simulate user editing .env with real credentials
      const customEnv =
        "LINEAR_API_KEY=lin_api_REAL_KEY\n" +
        "LINEAR_WEBHOOK_SECRET=whsec_REAL\n" +
        "DASHBOARD_PASSWORD=my_chosen_password\n";
      writeFileSync(join(projectDir, ".urateam", ".env"), customEnv);

      // Re-run scaffold with different options
      scaffold({
        projectDir,
        projectName: "rerun-project",
        linearApiKey: "lin_api_DIFFERENT",
        linearTeamId: "different-team",
        repoUrl: "https://github.com/other/repo",
        defaultBranch: "main",
      });

      const envAfter = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
      expect(envAfter).toBe(customEnv);
      expect(envAfter).toContain("lin_api_REAL_KEY");
      expect(envAfter).not.toContain("lin_api_DIFFERENT");
      expect(envAfter).toContain("my_chosen_password");
    });

    it("preserves existing .urateam/package.json with custom deps", () => {
      const projectDir = join(tempDir, "rerun-project");
      scaffold(baseOptions(projectDir, "rerun-project"));

      // Simulate user adding a custom dep to .urateam/package.json
      const customPkg = {
        name: "rerun-project-urateam",
        private: true,
        type: "module",
        scripts: { dev: "ura dev", start: "ura start" },
        dependencies: {
          "@urateam/cli": "^0.1.4",
          "some-custom-plugin": "^1.0.0",
        },
      };
      writeFileSync(
        join(projectDir, ".urateam", "package.json"),
        JSON.stringify(customPkg, null, 2) + "\n",
      );

      // Re-run scaffold
      scaffold(baseOptions(projectDir, "rerun-project"));

      const pkgAfter = JSON.parse(
        readFileSync(join(projectDir, ".urateam", "package.json"), "utf-8"),
      );
      expect(pkgAfter.dependencies["some-custom-plugin"]).toBe("^1.0.0");
    });

    it("refreshes template files like Dockerfile and docker-compose.yml", () => {
      const projectDir = join(tempDir, "rerun-project");
      scaffold(baseOptions(projectDir, "rerun-project"));

      // Simulate stale/corrupted Dockerfile
      writeFileSync(join(projectDir, ".urateam", "Dockerfile"), "# stale content");

      // Re-run scaffold
      scaffold(baseOptions(projectDir, "rerun-project"));

      const dockerfileAfter = readFileSync(
        join(projectDir, ".urateam", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfileAfter).not.toContain("# stale content");
      expect(dockerfileAfter).toContain("FROM node");
    });

    it(".gitignore append is idempotent across multiple runs", () => {
      const projectDir = join(tempDir, "rerun-project");
      scaffold(baseOptions(projectDir, "rerun-project"));
      scaffold(baseOptions(projectDir, "rerun-project"));
      scaffold(baseOptions(projectDir, "rerun-project"));

      const content = readFileSync(join(projectDir, ".gitignore"), "utf-8");
      const matches = content.match(/^\.urateam\/\.env$/gm);
      expect(matches?.length).toBe(1);
    });
  });
});

describe("decodeLicense", () => {
  // We import lazily inside each test to keep the existing top-of-file
  // import structure clean.
  it("decodes a Pro JWT and reads tier + features", async () => {
    const { decodeLicense } = await import("../index.js");
    // Hand-rolled unsigned JWT (header.payload.signature — signature ignored by decoder)
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "urateams.com",
        sub: "cust_test",
        tier: "pro",
        features: ["slack-interface", "deep-review", "multi-repo"],
        exp: 2_000_000_000,
      }),
    ).toString("base64url");
    const jwt = `${header}.${payload}.x`;

    const info = decodeLicense(jwt);
    expect(info?.tier).toBe("pro");
    expect(info?.features).toEqual(["slack-interface", "deep-review", "multi-repo"]);
    expect(info?.customerId).toBe("cust_test");
  });

  it("returns null on malformed JWT", async () => {
    const { decodeLicense } = await import("../index.js");
    expect(decodeLicense("not.a.jwt")).toBeNull();
    expect(decodeLicense("")).toBeNull();
    expect(decodeLicense(undefined)).toBeNull();
    expect(decodeLicense("only.two")).toBeNull();
  });

  it("falls back to oss tier for unknown tier values", async () => {
    const { decodeLicense } = await import("../index.js");
    const payload = Buffer.from(JSON.stringify({ tier: "rogue" })).toString("base64url");
    expect(decodeLicense(`x.${payload}.y`)?.tier).toBe("oss");
  });

  it("expands Pro tier to all Pro features when JWT has no explicit features", async () => {
    // A license issued with `ura license issue --tier pro` (no --features flag)
    // gets a JWT with no `features` field. Runtime grants all Pro features
    // implicitly via tier — scaffolder must match that or it'll skip
    // tier-gated prompts (e.g. PM agent setup) for such licenses.
    const { decodeLicense } = await import("../index.js");
    const payload = Buffer.from(
      JSON.stringify({ tier: "pro", sub: "cust", exp: 2_000_000_000 }),
    ).toString("base64url");
    const info = decodeLicense(`x.${payload}.y`);
    expect(info?.tier).toBe("pro");
    expect(info?.features).toEqual(
      expect.arrayContaining(["slack-interface", "deep-review", "multi-repo"]),
    );
  });

  it("expands Enterprise tier to all Enterprise features when JWT has no explicit features", async () => {
    const { decodeLicense } = await import("../index.js");
    const payload = Buffer.from(JSON.stringify({ tier: "enterprise" })).toString("base64url");
    const info = decodeLicense(`x.${payload}.y`);
    expect(info?.features).toEqual(
      expect.arrayContaining(["slack-interface", "sso", "audit-log", "rbac"]),
    );
  });

  it("honors an explicit features array even when shorter than the tier default", async () => {
    // Operators can issue restricted licenses (e.g. Pro tier minus deep-review).
    // The explicit list wins.
    const { decodeLicense } = await import("../index.js");
    const payload = Buffer.from(
      JSON.stringify({ tier: "pro", features: ["multi-repo"] }),
    ).toString("base64url");
    const info = decodeLicense(`x.${payload}.y`);
    expect(info?.features).toEqual(["multi-repo"]);
  });
});

describe("scaffold — production options", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "create-urateam-test-prod-"));
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes DOMAIN + CADDY_EMAIL when deployMode is production", () => {
    const projectDir = join(tempDir, "prod");
    scaffold({
      projectDir,
      projectName: "prod",
      linearApiKey: "lin_api",
      linearTeamId: "team-1",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      deployMode: "production",
      domain: "myateam.example.com",
      caddyEmail: "ops@example.com",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toContain("DOMAIN=myateam.example.com");
    expect(env).toContain("CADDY_EMAIL=ops@example.com");
  });

  it("omits DOMAIN block when deployMode is local", () => {
    const projectDir = join(tempDir, "loc");
    scaffold({
      projectDir,
      projectName: "loc",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      deployMode: "local",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).not.toContain("DOMAIN=");
    expect(env).not.toContain("CADDY_EMAIL=");
  });

  it("writes PM_AGENT block when pmAgent is provided", () => {
    const projectDir = join(tempDir, "pm");
    scaffold({
      projectDir,
      projectName: "pm",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      pmAgent: {
        slackBotToken: "xoxb-123",
        slackSigningSecret: "sig123",
        slackChannelId: "C123",
        teamIds: "team-1,team-2",
        dailyTokenBudget: 7_500_000,
      },
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toContain("PM_AGENT_ENABLED=true");
    expect(env).toContain("PM_AGENT_TEAM_IDS=team-1,team-2");
    expect(env).toContain("PM_AGENT_SLACK_CHANNEL_ID=C123");
    expect(env).toContain("PM_AGENT_DAILY_TOKEN_BUDGET=7500000");
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-123");
  });

  it("comments out PM_AGENT block by default", () => {
    const projectDir = join(tempDir, "no-pm");
    scaffold({
      projectDir,
      projectName: "no-pm",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toContain("# PM_AGENT_ENABLED=true");
    expect(env).not.toMatch(/^PM_AGENT_ENABLED=true/m);
  });

  it("leaves DASHBOARD/POSTGRES blank when autoGenSecrets is false", () => {
    // GITHUB_WEBHOOK_SECRET is no longer auto-generated regardless — it's
    // shared with GitHub's webhook config and prompted explicitly.
    const projectDir = join(tempDir, "manual-secrets");
    const result = scaffold({
      projectDir,
      projectName: "manual-secrets",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      autoGenSecrets: false,
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toMatch(/^DASHBOARD_PASSWORD=$/m);
    expect(env).toMatch(/^POSTGRES_PASSWORD=$/m);
    expect(result.generatedSecrets).toEqual({});
    expect(result.todos).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DASHBOARD_PASSWORD"),
        expect.stringContaining("POSTGRES_PASSWORD"),
      ]),
    );
  });

  it("auto-generates GITHUB_WEBHOOK_SECRET when autoGenSecrets is true and none provided", () => {
    const projectDir = join(tempDir, "gh-secret-autogen");
    const result = scaffold({
      projectDir,
      projectName: "x",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      autoGenSecrets: true,
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toMatch(/^GITHUB_WEBHOOK_SECRET=[a-f0-9]{64}$/m);
    expect(result.generatedSecrets.githubWebhookSecret).toMatch(/^[a-f0-9]{64}$/);
  });

  it("explicit GITHUB_WEBHOOK_SECRET wins over auto-gen", () => {
    const projectDir = join(tempDir, "gh-secret-explicit-wins");
    const result = scaffold({
      projectDir,
      projectName: "x",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      autoGenSecrets: true,
      githubWebhookSecret: "operator-paste-from-github",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toMatch(/^GITHUB_WEBHOOK_SECRET=operator-paste-from-github$/m);
    // Not in generated set since it came from the operator.
    expect(result.generatedSecrets.githubWebhookSecret).toBeUndefined();
  });

  it("leaves GITHUB_WEBHOOK_SECRET commented when autoGenSecrets is false and none provided", () => {
    const projectDir = join(tempDir, "gh-secret-blank");
    const result = scaffold({
      projectDir,
      projectName: "x",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      autoGenSecrets: false,
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toMatch(/^# GITHUB_WEBHOOK_SECRET=/m);
    expect(env).not.toMatch(/^GITHUB_WEBHOOK_SECRET=\S/m);
    expect(result.generatedSecrets.githubWebhookSecret).toBeUndefined();
  });


  it("returns license info in result when licenseKey decodes", () => {
    const payload = Buffer.from(
      JSON.stringify({ tier: "pro", features: ["slack-interface"] }),
    ).toString("base64url");
    const projectDir = join(tempDir, "lic");
    const result = scaffold({
      projectDir,
      projectName: "lic",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      licenseKey: `x.${payload}.y`,
    });
    expect(result.license?.tier).toBe("pro");
    expect(result.license?.features).toContain("slack-interface");
  });

  it("Dockerfile bakes in the system-wide gh→git credential helper", () => {
    const projectDir = join(tempDir, "git-helper");
    scaffold({
      projectDir,
      projectName: "git-helper",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
    });
    const dockerfile = readFileSync(
      join(projectDir, ".urateam", "Dockerfile"),
      "utf-8",
    );
    // System-wide config (/etc/gitconfig) survives container restarts WITHOUT
    // a volume mount, so git operations against private repos keep working
    // after `gh auth login` — even across `docker compose down/up` cycles.
    expect(dockerfile).toMatch(/git config --system credential\.helper/);
    expect(dockerfile).toContain("!gh auth git-credential");
  });

  it("docker-compose has CADDY_EMAIL in caddy environment + bind-mount for credentials.json", () => {
    const projectDir = join(tempDir, "compose-vars");
    scaffold({
      projectDir,
      projectName: "compose-vars",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
    });
    const compose = readFileSync(
      join(projectDir, ".urateam", "docker-compose.yml"),
      "utf-8",
    );
    expect(compose).toMatch(/CADDY_EMAIL: \$\{CADDY_EMAIL\}/);
    // Bind-mount instead of named volume — credentials.json needs cross-restart
    // persistence and named volumes don't bind-mount single files.
    expect(compose).toMatch(
      /\$\{HOME\}\/\.claude\/\.credentials\.json:\/root\/\.claude\/\.credentials\.json:rw/,
    );
    // Old approach (named claude-config volume) should NOT be present.
    expect(compose).not.toMatch(/claude-config:/);
  });

  it("AGENT_BYPASS_PERMISSIONS=true uncommented in local mode", () => {
    const projectDir = join(tempDir, "perm-local");
    scaffold({
      projectDir,
      projectName: "perm-local",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      deployMode: "local",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toMatch(/^AGENT_BYPASS_PERMISSIONS=true$/m);
  });

  it("AGENT_BYPASS_PERMISSIONS commented out in production mode", () => {
    const projectDir = join(tempDir, "perm-prod");
    scaffold({
      projectDir,
      projectName: "perm-prod",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      deployMode: "production",
      domain: "x.example.com",
      caddyEmail: "x@x.com",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toMatch(/^# AGENT_BYPASS_PERMISSIONS=true/m);
    expect(env).not.toMatch(/^AGENT_BYPASS_PERMISSIONS=true$/m);
  });

  it("writes DASHBOARD_BASE_PATH when provided, comments out otherwise", () => {
    const projectDir = join(tempDir, "base-path");
    scaffold({
      projectDir,
      projectName: "base-path",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      dashboardBasePath: "/ateam",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toMatch(/^DASHBOARD_BASE_PATH=\/ateam$/m);

    // And without it: line stays commented.
    const projectDir2 = join(tempDir, "no-base-path");
    scaffold({
      projectDir: projectDir2,
      projectName: "no-base-path",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
    });
    const env2 = readFileSync(join(projectDir2, ".urateam", ".env"), "utf-8");
    expect(env2).toMatch(/^# DASHBOARD_BASE_PATH=/m);
  });

  it("writes SLACK_WEBHOOK_URL and DISCORD_WEBHOOK_URL when provided", () => {
    const projectDir = join(tempDir, "notif");
    scaffold({
      projectDir,
      projectName: "notif",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      slackWebhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC",
      discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toContain("SLACK_WEBHOOK_URL=https://hooks.slack.com/services/AAA/BBB/CCC");
    expect(env).toContain("DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/abc");
  });

  it("writes URATEAM_AGENT_PROFILES as bare (unquoted) valid JSON", () => {
    const projectDir = join(tempDir, "profiles");
    scaffold({
      projectDir,
      projectName: "profiles",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      agentProfiles: {
        test: { maxTurns: 50, maxInputTokens: 80000 },
        review: { model: "claude-opus-4-7" },
      },
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    // Bare value (no surrounding quotes) — surrounding single-quotes break Docker
    // Compose's env_file parser. Must not match a quoted variant.
    const match = env.match(/^URATEAM_AGENT_PROFILES=(\{.*\})$/m);
    expect(match).not.toBeNull();
    expect(env).not.toMatch(/^URATEAM_AGENT_PROFILES='/m);
    expect(env).not.toMatch(/^URATEAM_AGENT_PROFILES="/m);
    const parsed = JSON.parse(match![1]);
    expect(parsed.test).toEqual({ maxTurns: 50, maxInputTokens: 80000 });
    expect(parsed.review).toEqual({ model: "claude-opus-4-7" });
  });

  it("URATEAM_AGENT_PROFILES survives Node 22 process.loadEnvFile round-trip", async () => {
    // Integration test: the actual env-file parser must extract the JSON cleanly.
    // Without this, the wizard silently breaks under docker-compose env_file
    // (which has parser quirks similar to Node's). See PR #127 Sonnet review C1.
    const { execFileSync } = await import("child_process");
    const projectDir = join(tempDir, "loadenv");
    scaffold({
      projectDir,
      projectName: "loadenv",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      agentProfiles: {
        test: { maxTurns: 50, maxInputTokens: 80000 },
      },
    });
    const envPath = join(projectDir, ".urateam", ".env");
    const out = execFileSync(
      "node",
      [
        `--env-file=${envPath}`,
        "-e",
        "console.log(JSON.stringify(JSON.parse(process.env.URATEAM_AGENT_PROFILES)))",
      ],
      { encoding: "utf-8" },
    ).trim();
    expect(JSON.parse(out)).toEqual({ test: { maxTurns: 50, maxInputTokens: 80000 } });
  });

  it("normalizeBasePath strips trailing slashes and ensures leading slash", async () => {
    const { normalizeBasePath } = await import("../index.js");
    expect(normalizeBasePath("/ateam")).toBe("/ateam");
    expect(normalizeBasePath("/ateam/")).toBe("/ateam");
    expect(normalizeBasePath("/ateam///")).toBe("/ateam");
    expect(normalizeBasePath("ateam")).toBe("/ateam");
    expect(normalizeBasePath("  /ateam/  ")).toBe("/ateam");
    expect(normalizeBasePath("")).toBeUndefined();
    expect(normalizeBasePath("///")).toBeUndefined();
    expect(normalizeBasePath(undefined)).toBeUndefined();
  });

  it("writes GITHUB_FEEDBACK_* lines when githubFeedback is provided", () => {
    const projectDir = join(tempDir, "fb");
    scaffold({
      projectDir,
      projectName: "fb",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      githubFeedback: {
        triggerKeyword: "/retry",
        allowedReviewers: "alice,bob",
        autoTrigger: false,
      },
    });
    const env = readFileSync(join(projectDir, ".urateam", ".env"), "utf-8");
    expect(env).toContain("GITHUB_FEEDBACK_AUTO_TRIGGER=false");
    expect(env).toContain("GITHUB_FEEDBACK_TRIGGER_KEYWORD=/retry");
    expect(env).toContain("GITHUB_FEEDBACK_ALLOWED_REVIEWERS=alice,bob");
  });

  it("surfaces a TODO when license has slack-interface but no pmAgent provided", () => {
    const payload = Buffer.from(
      JSON.stringify({ tier: "pro", features: ["slack-interface"] }),
    ).toString("base64url");
    const projectDir = join(tempDir, "lic-todo");
    const result = scaffold({
      projectDir,
      projectName: "lic-todo",
      linearApiKey: "x",
      linearTeamId: "t",
      repoUrl: "https://github.com/o/r",
      defaultBranch: "main",
      licenseKey: `x.${payload}.y`,
    });
    expect(result.todos).toEqual(
      expect.arrayContaining([expect.stringContaining("PM_AGENT_*")]),
    );
  });
});
