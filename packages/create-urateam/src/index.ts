#!/usr/bin/env node
import { mkdirSync, writeFileSync, cpSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ScaffoldOptions {
  projectDir: string;
  projectName: string;
  linearApiKey: string;
  linearTeamId: string;
  repoUrl: string;
  defaultBranch: string;
}

/**
 * Scaffold a new urateam project from the template.
 * Copies template files, generates .env and package.json, replaces placeholders.
 */
export function scaffold(options: ScaffoldOptions): void {
  const { projectDir, projectName, linearApiKey, linearTeamId, repoUrl, defaultBranch } = options;

  // Copy template directory
  // When running from dist/, template is at ../template/
  // When running from src/ (tests), template is at ../../template/
  let templateDir = join(__dirname, "..", "template");
  if (!statSync(templateDir, { throwIfNoEntry: false })?.isDirectory()) {
    templateDir = join(__dirname, "..", "..", "template");
  }
  cpSync(templateDir, projectDir, { recursive: true });

  // Write package.json
  const pkg = {
    name: projectName,
    private: true,
    type: "module",
    scripts: {
      dev: "ura dev",
      start: "ura start",
    },
    dependencies: {
      "@urateam/cli": "^0.1.0",
    },
  };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // Write .env from provided values
  const envContent = [
    `LINEAR_API_KEY=${linearApiKey}`,
    `LINEAR_WEBHOOK_SECRET=`,
    `LINEAR_TEAM_ID=${linearTeamId}`,
    `REPO_URL=${repoUrl}`,
    `REPO_DEFAULT_BRANCH=${defaultBranch}`,
    `REPO_TEAM_ID=${linearTeamId}`,
    `DATABASE_URL=postgres://urateam:password@postgres:5432/urateam`,
    `DASHBOARD_USER=admin`,
    `DASHBOARD_PASSWORD=${randomBytes(16).toString("hex")}`,
  ].join("\n") + "\n";
  writeFileSync(join(projectDir, ".env"), envContent);

  // Replace {{PROJECT_NAME}} in README.md
  const readmePath = join(projectDir, "README.md");
  const readme = readFileSync(readmePath, "utf-8");
  writeFileSync(readmePath, readme.replace(/\{\{PROJECT_NAME\}\}/g, projectName));
}

// CLI entrypoint — only runs when executed directly (not when imported for testing)
async function main() {
  const projectName = process.argv[2];
  if (!projectName) {
    console.error("Usage: create-urateam <project-name>");
    process.exit(1);
  }

  const prompts = (await import("prompts")).default;
  const response = await prompts([
    { type: "text", name: "linearApiKey", message: "Linear API key:" },
    { type: "text", name: "linearTeamId", message: "Linear team ID:" },
    { type: "text", name: "repoUrl", message: "Repo URL (GitHub/GitLab):" },
    { type: "text", name: "defaultBranch", message: "Default branch:", initial: "main" },
  ]);

  if (!response.linearApiKey || !response.repoUrl) {
    console.error("Cancelled.");
    process.exit(1);
  }

  const projectDir = join(process.cwd(), projectName);
  scaffold({
    projectDir,
    projectName,
    linearApiKey: response.linearApiKey,
    linearTeamId: response.linearTeamId,
    repoUrl: response.repoUrl,
    defaultBranch: response.defaultBranch || "main",
  });

  console.log(`\n  Created ${projectName} in ${projectDir}\n`);
  console.log(`  Next steps:`);
  console.log(`    cd ${projectName}`);
  console.log(`    pnpm install`);
  console.log(`    ura dev\n`);
}

const isEntrypoint = process.argv[1]?.endsWith("create-urateam") ||
                     process.argv[1]?.endsWith("index.js");
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
