import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TechStackProfile {
  languages: string[];
  frameworks: string[];
  buildSystems: string[];
  hasDevcontainer: boolean;
  devcontainerPath?: string;
}

interface MarkerCheck {
  file: string;
  language?: string;
  buildSystem?: string;
  /** Parse the file to detect frameworks */
  detectFrameworks?: (content: string) => string[];
}

const MARKERS: MarkerCheck[] = [
  {
    file: "package.json",
    language: "javascript",
    buildSystem: "npm",
    detectFrameworks: (content: string) => {
      const frameworks: string[] = [];
      try {
        const pkg = JSON.parse(content);
        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };
        if (allDeps.typescript || pkg.devDependencies?.typescript) frameworks.push("typescript");
        if (allDeps.react) frameworks.push("react");
        if (allDeps.next) frameworks.push("nextjs");
        if (allDeps.vue) frameworks.push("vue");
        if (allDeps["@angular/core"]) frameworks.push("angular");
        if (allDeps.express) frameworks.push("express");
        if (allDeps["@nestjs/core"]) frameworks.push("nestjs");
        if (allDeps.hono) frameworks.push("hono");
        if (allDeps.svelte) frameworks.push("svelte");
      } catch {
        // Invalid JSON — skip framework detection
      }
      return frameworks;
    },
  },
  { file: "tsconfig.json", language: "typescript" },
  { file: "Cargo.toml", language: "rust", buildSystem: "cargo" },
  { file: "go.mod", language: "go", buildSystem: "go-mod" },
  { file: "pyproject.toml", language: "python", buildSystem: "poetry" },
  { file: "requirements.txt", language: "python", buildSystem: "pip" },
  { file: "Pipfile", language: "python", buildSystem: "pipenv" },
  { file: "pom.xml", language: "java", buildSystem: "maven" },
  { file: "build.gradle", language: "java", buildSystem: "gradle" },
  { file: "build.gradle.kts", language: "kotlin", buildSystem: "gradle" },
  { file: "Gemfile", language: "ruby", buildSystem: "bundler" },
  { file: "composer.json", language: "php", buildSystem: "composer" },
  { file: "mix.exs", language: "elixir", buildSystem: "mix" },
  { file: "pnpm-lock.yaml", buildSystem: "pnpm" },
  { file: "yarn.lock", buildSystem: "yarn" },
  { file: "bun.lockb", buildSystem: "bun" },
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the tech stack of a project by scanning for marker files.
 * Fast, file-existence-based detection — no AST parsing.
 */
export async function detectTechStack(worktreePath: string): Promise<TechStackProfile> {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const buildSystems = new Set<string>();

  // Check all markers in parallel
  const checks = MARKERS.map(async (marker) => {
    const filePath = join(worktreePath, marker.file);
    const exists = await fileExists(filePath);
    if (!exists) return;

    if (marker.language) languages.add(marker.language);
    if (marker.buildSystem) buildSystems.add(marker.buildSystem);

    if (marker.detectFrameworks) {
      try {
        const content = await readFile(filePath, "utf-8");
        for (const fw of marker.detectFrameworks(content)) {
          frameworks.add(fw);
        }
      } catch {
        // Can't read file — skip framework detection
      }
    }
  });

  await Promise.all(checks);

  // Typescript detection from tsconfig upgrades javascript → typescript
  if (languages.has("typescript") && languages.has("javascript")) {
    languages.delete("javascript");
  }

  // Check for devcontainer
  const devcontainerPath = ".devcontainer/devcontainer.json";
  const hasDevcontainer = await fileExists(join(worktreePath, devcontainerPath));

  return {
    languages: [...languages],
    frameworks: [...frameworks],
    buildSystems: [...buildSystems],
    hasDevcontainer,
    devcontainerPath: hasDevcontainer ? devcontainerPath : undefined,
  };
}
