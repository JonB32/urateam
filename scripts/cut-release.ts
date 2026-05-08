#!/usr/bin/env tsx
/**
 * BEC-176: `pnpm cut-release patch|minor|major [--dry-run] [--push]`
 *
 * Bumps every version-bearing file atomically and stages a release commit:
 *   1. packages/{core,cli,dashboard,create-urateam}/package.json
 *   2. Dockerfile ARGs (URATEAM_CORE_VERSION / CLI / DASHBOARD)
 *   3. docker-compose.dogfood.yml `args:` block
 *   4. CHANGELOG.md (new section above the latest existing one)
 *
 * Idempotent: re-running when a section for the same release tag already
 * exists is a no-op for the changelog (the package.json bumps will run
 * again — re-running cleanly is the operator's responsibility).
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpAll,
  bumpComposeFile,
  bumpDockerfile,
  bumpPackageJson,
  buildChangelogEntry,
  insertChangelogEntry,
  nextReleaseTag,
  type BumpKind,
  type PackageVersions,
} from "./cut-release-lib.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

interface FilePatch {
  path: string;
  before: string;
  after: string;
}

function readPkg(rel: string): { content: string; version: string } {
  const content = readFileSync(resolve(REPO_ROOT, rel), "utf8");
  const m = /"version":\s*"([^"]+)"/.exec(content);
  if (!m) throw new Error(`no version field in ${rel}`);
  return { content, version: m[1]! };
}

function getCurrentVersions(): PackageVersions {
  return {
    core: readPkg("packages/core/package.json").version,
    cli: readPkg("packages/cli/package.json").version,
    dashboard: readPkg("packages/dashboard/package.json").version,
    createUrateam: readPkg("packages/create-urateam/package.json").version,
  };
}

function getReleaseTags(): string[] {
  try {
    return execSync("git tag -l 'v*' --sort=-v:refname", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildPatches(
  prev: PackageVersions,
  next: PackageVersions,
  releaseTag: string,
  date: string,
): FilePatch[] {
  const patches: FilePatch[] = [];

  for (const [rel, ver] of [
    ["packages/core/package.json", next.core],
    ["packages/cli/package.json", next.cli],
    ["packages/dashboard/package.json", next.dashboard],
    ["packages/create-urateam/package.json", next.createUrateam],
  ] as const) {
    const before = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    const after = bumpPackageJson(before, ver);
    if (before !== after) patches.push({ path: rel, before, after });
  }

  const dockerfileBefore = readFileSync(resolve(REPO_ROOT, "Dockerfile"), "utf8");
  const dockerfileAfter = bumpDockerfile(dockerfileBefore, next);
  if (dockerfileBefore !== dockerfileAfter) {
    patches.push({ path: "Dockerfile", before: dockerfileBefore, after: dockerfileAfter });
  }

  const composeBefore = readFileSync(
    resolve(REPO_ROOT, "docker-compose.dogfood.yml"),
    "utf8",
  );
  const composeAfter = bumpComposeFile(composeBefore, next);
  if (composeBefore !== composeAfter) {
    patches.push({
      path: "docker-compose.dogfood.yml",
      before: composeBefore,
      after: composeAfter,
    });
  }

  const changelogBefore = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const entry = buildChangelogEntry({ releaseTag, date, prev, next });
  const changelogAfter = insertChangelogEntry(changelogBefore, entry);
  if (changelogBefore !== changelogAfter) {
    patches.push({
      path: "CHANGELOG.md",
      before: changelogBefore,
      after: changelogAfter,
    });
  }

  return patches;
}

function applyPatches(patches: FilePatch[]): void {
  for (const p of patches) {
    writeFileSync(resolve(REPO_ROOT, p.path), p.after);
  }
}

interface CliArgs {
  bump: BumpKind;
  dryRun: boolean;
  push: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const bump = positional[0];
  if (bump !== "patch" && bump !== "minor" && bump !== "major") {
    throw new Error(
      `usage: pnpm cut-release patch|minor|major [--dry-run] [--push]\n  got: ${argv.join(" ")}`,
    );
  }
  return {
    bump,
    dryRun: flags.has("--dry-run"),
    push: flags.has("--push"),
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const prev = getCurrentVersions();
  const next = bumpAll(prev, args.bump);
  const releaseTag = nextReleaseTag(getReleaseTags(), args.bump);
  const date = today();

  const patches = buildPatches(prev, next, releaseTag, date);

  console.log(`Cut release: ${releaseTag}  (date ${date})`);
  console.log("Bumps:");
  console.log(`  @urateam/core:        ${prev.core} → ${next.core}`);
  console.log(`  @urateam/cli:         ${prev.cli} → ${next.cli}`);
  console.log(`  @urateam/dashboard:   ${prev.dashboard} → ${next.dashboard}`);
  console.log(`  create-urateam:       ${prev.createUrateam} → ${next.createUrateam}`);
  console.log("");
  console.log(`Files to update (${patches.length}):`);
  for (const p of patches) console.log(`  ${p.path}`);

  if (args.dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  if (patches.length === 0) {
    console.log("\nNothing to do — already on target versions.");
    return;
  }

  applyPatches(patches);

  const branch = `chore/release-${releaseTag}`;
  console.log(`\nCreating branch ${branch} and committing...`);
  execSync(`git checkout -b ${branch}`, { cwd: REPO_ROOT, stdio: "inherit" });
  execSync(`git add ${patches.map((p) => p.path).join(" ")}`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  const message = `chore(release): ${releaseTag}\n\nBumps:\n` +
    `- @urateam/core:        ${prev.core} → ${next.core}\n` +
    `- @urateam/cli:         ${prev.cli} → ${next.cli}\n` +
    `- @urateam/dashboard:   ${prev.dashboard} → ${next.dashboard}\n` +
    `- create-urateam:       ${prev.createUrateam} → ${next.createUrateam}\n`;
  execSync(`git commit -m ${JSON.stringify(message)}`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  if (args.push) {
    console.log(`\nPushing ${branch} and opening PR...`);
    execSync(`git push -u origin ${branch}`, { cwd: REPO_ROOT, stdio: "inherit" });
    execSync(
      `gh pr create --title "chore(release): ${releaseTag}" --body "Automated bump via \`pnpm cut-release ${args.bump}\`. Edit the CHANGELOG TODO before merging."`,
      { cwd: REPO_ROOT, stdio: "inherit" },
    );
  } else {
    console.log("\nDone. Next steps:");
    console.log(
      `  1. Edit CHANGELOG.md to replace the TODO with ### Added / ### Fixed sections`,
    );
    console.log(`  2. git push -u origin ${branch}`);
    console.log(`  3. gh pr create`);
    console.log(
      `  4. After merge: git tag ${releaseTag} <merge-sha> && git push origin ${releaseTag}`,
    );
    console.log(
      `  5. gh release create ${releaseTag} --title "${releaseTag} — <feature>" --notes ...`,
    );
  }
}

main();
