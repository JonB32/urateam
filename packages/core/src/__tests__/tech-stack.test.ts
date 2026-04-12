import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectTechStack } from "../repo/tech-stack.js";

describe("detectTechStack", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tech-stack-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects typescript + react from package.json", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    await writeFile(join(dir, "tsconfig.json"), "{}");

    const result = await detectTechStack(dir);
    expect(result.languages).toContain("typescript");
    expect(result.languages).not.toContain("javascript"); // typescript supersedes
    expect(result.frameworks).toContain("react");
    expect(result.buildSystems).toContain("npm");
  });

  it("detects python from requirements.txt", async () => {
    await writeFile(join(dir, "requirements.txt"), "flask==2.0.0\n");

    const result = await detectTechStack(dir);
    expect(result.languages).toContain("python");
    expect(result.buildSystems).toContain("pip");
  });

  it("detects rust from Cargo.toml", async () => {
    await writeFile(join(dir, "Cargo.toml"), '[package]\nname = "test"\n');

    const result = await detectTechStack(dir);
    expect(result.languages).toContain("rust");
    expect(result.buildSystems).toContain("cargo");
  });

  it("detects go from go.mod", async () => {
    await writeFile(join(dir, "go.mod"), "module example.com/test\n");

    const result = await detectTechStack(dir);
    expect(result.languages).toContain("go");
    expect(result.buildSystems).toContain("go-mod");
  });

  it("detects pnpm from lock file", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");

    const result = await detectTechStack(dir);
    expect(result.buildSystems).toContain("pnpm");
  });

  it("detects devcontainer", async () => {
    await mkdir(join(dir, ".devcontainer"), { recursive: true });
    await writeFile(
      join(dir, ".devcontainer/devcontainer.json"),
      JSON.stringify({ name: "test" }),
    );

    const result = await detectTechStack(dir);
    expect(result.hasDevcontainer).toBe(true);
    expect(result.devcontainerPath).toBe(".devcontainer/devcontainer.json");
  });

  it("returns empty profile for empty directory", async () => {
    const result = await detectTechStack(dir);
    expect(result.languages).toEqual([]);
    expect(result.frameworks).toEqual([]);
    expect(result.buildSystems).toEqual([]);
    expect(result.hasDevcontainer).toBe(false);
  });

  it("detects multiple frameworks from package.json", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );

    const result = await detectTechStack(dir);
    expect(result.frameworks).toContain("react");
    expect(result.frameworks).toContain("nextjs");
    expect(result.frameworks).toContain("typescript");
  });
});
