#!/usr/bin/env node
import {
  mkdirSync,
  writeFileSync,
  cpSync,
  readFileSync,
  statSync,
  existsSync,
  appendFileSync,
} from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ScaffoldOptions {
  /** The project root directory. `.urateam/` will be created inside it. */
  projectDir: string;
  /** Project name — used in CLAUDE.md header and .urateam/package.json. */
  projectName: string;
  linearApiKey: string;
  linearTeamId: string;
  repoUrl: string;
  defaultBranch: string;
}

/**
 * Scaffold a urateam sidecar into a project directory.
 *
 * Creates:
 *   - <projectDir>/.urateam/            — isolated urateam config + deps
 *     - package.json                    — depends on @urateam/cli
 *     - .env                            — Linear keys, webhook secret, etc.
 *     - .env.example
 *     - Dockerfile
 *     - docker-compose.yml
 *     - README.md                       — how to run the sidecar
 *   - <projectDir>/CLAUDE.md            — project conventions (only if absent)
 *   - <projectDir>/README.md            — project readme (only if absent)
 *   - <projectDir>/.gitignore           — ensures .urateam/.env is ignored
 *
 * The project root `package.json` is NOT touched — urateam is a sidecar tool,
 * not a project dependency. Existing `CLAUDE.md` at the project root is
 * preserved (not overwritten).
 */
export function scaffold(options: ScaffoldOptions): void {
  const { projectDir, projectName, linearApiKey, linearTeamId, repoUrl, defaultBranch } = options;

  mkdirSync(projectDir, { recursive: true });

  // Locate template directory (supports running from dist/ or src/ during tests)
  let templateDir = join(__dirname, "..", "template");
  if (!statSync(templateDir, { throwIfNoEntry: false })?.isDirectory()) {
    templateDir = join(__dirname, "..", "..", "template");
  }

  // --- Sidecar files: copy template/.urateam/ → projectDir/.urateam/ (force overwrite) ---
  const urateamDir = join(projectDir, ".urateam");
  cpSync(join(templateDir, ".urateam"), urateamDir, { recursive: true, force: true });

  // Write .urateam/package.json — the sidecar's own package.json
  const pkg = {
    name: `${projectName}-urateam`,
    private: true,
    type: "module",
    scripts: {
      dev: "ura dev",
      start: "ura start",
    },
    dependencies: {
      "@urateam/cli": "^0.1.2",
    },
  };
  writeFileSync(join(urateamDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // Write .urateam/.env from user-provided values
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
  writeFileSync(join(urateamDir, ".env"), envContent);

  // --- Project root files: copy only if absent (don't clobber user files) ---
  // Files with {{PROJECT_NAME}} placeholder get the substitution applied.
  const rootFilesWithPlaceholder = ["CLAUDE.md", "README.md"];
  for (const file of rootFilesWithPlaceholder) {
    const dest = join(projectDir, file);
    if (existsSync(dest)) continue;
    const src = join(templateDir, file);
    if (!existsSync(src)) continue;
    const content = readFileSync(src, "utf-8");
    writeFileSync(dest, content.replace(/\{\{PROJECT_NAME\}\}/g, projectName));
  }

  // Ensure .gitignore at project root has the urateam entries
  const gitignorePath = join(projectDir, ".gitignore");
  const gitignoreTemplateSrc = join(templateDir, ".gitignore");
  const templateGitignore = readFileSync(gitignoreTemplateSrc, "utf-8");

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, templateGitignore);
  } else {
    const existing = readFileSync(gitignorePath, "utf-8");
    // Check for the bare `.urateam/.env` entry as a standalone line.
    // Loose substring match would false-positive on `!.urateam/.env.example`.
    const hasBareEntry = existing
      .split(/\r?\n/)
      .some((line) => line.trim() === ".urateam/.env");
    if (!hasBareEntry) {
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      appendFileSync(gitignorePath, separator + templateGitignore);
    }
  }
}

// CLI entrypoint — only runs when executed directly (not when imported for testing)
async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: create-urateam <project-name-or-dot>");
    console.error("  create-urateam my-project   # creates new directory");
    console.error("  create-urateam .            # adds .urateam/ to current directory");
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

  const projectDir = arg === "." ? process.cwd() : join(process.cwd(), arg);
  const projectName = arg === "." ? basename(projectDir) || "my-project" : arg;

  scaffold({
    projectDir,
    projectName,
    linearApiKey: response.linearApiKey,
    linearTeamId: response.linearTeamId,
    repoUrl: response.repoUrl,
    defaultBranch: response.defaultBranch || "main",
  });

  console.log(`\n  urateam sidecar installed in ${projectDir}/.urateam\n`);
  console.log(`  Next steps:`);
  if (arg !== ".") console.log(`    cd ${arg}`);
  console.log(`    cd .urateam`);
  console.log(`    pnpm install`);
  console.log(`    ura dev`);
  console.log(`\n  See CLAUDE.md in the project root for agent context.\n`);
}

const isEntrypoint = process.argv[1]?.endsWith("create-urateam") ||
                     process.argv[1]?.endsWith("index.js");
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
