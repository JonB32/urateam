/**
 * BEC-176: pure functions for the `pnpm cut-release` helper.
 *
 * Only string manipulation here — no fs, no git, no exec. The orchestration
 * script (cut-release.ts) is the only place those happen, which keeps this
 * module trivially testable.
 */

export type BumpKind = "patch" | "minor" | "major";

export interface PackageVersions {
  core: string;
  cli: string;
  dashboard: string;
  createUrateam: string;
}

export function bumpVersion(v: string, kind: BumpKind): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`bumpVersion: invalid semver "${v}"`);
  const maj = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  const pat = parseInt(m[3]!, 10);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function bumpAll(prev: PackageVersions, kind: BumpKind): PackageVersions {
  return {
    core: bumpVersion(prev.core, kind),
    cli: bumpVersion(prev.cli, kind),
    dashboard: bumpVersion(prev.dashboard, kind),
    createUrateam: bumpVersion(prev.createUrateam, kind),
  };
}

/** Replace the top-level `"version": "..."` field. Preserves all other formatting. */
export function bumpPackageJson(content: string, newVersion: string): string {
  return content.replace(/("version":\s*)"[^"]+"/, `$1"${newVersion}"`);
}

export function bumpDockerfile(
  content: string,
  v: { core: string; cli: string; dashboard: string },
): string {
  return content
    .replace(/^(ARG URATEAM_CORE_VERSION=)[\d.]+/m, `$1${v.core}`)
    .replace(/^(ARG URATEAM_CLI_VERSION=)[\d.]+/m, `$1${v.cli}`)
    .replace(/^(ARG URATEAM_DASHBOARD_VERSION=)[\d.]+/m, `$1${v.dashboard}`);
}

export function bumpComposeFile(
  content: string,
  v: { core: string; cli: string; dashboard: string },
): string {
  return content
    .replace(/(URATEAM_CORE_VERSION:\s*)[\d.]+/, `$1${v.core}`)
    .replace(/(URATEAM_CLI_VERSION:\s*)[\d.]+/, `$1${v.cli}`)
    .replace(/(URATEAM_DASHBOARD_VERSION:\s*)[\d.]+/, `$1${v.dashboard}`);
}

export function buildChangelogEntry(args: {
  releaseTag: string;
  date: string;
  prev: PackageVersions;
  next: PackageVersions;
}): string {
  const ver = args.releaseTag.replace(/^v/, "");
  return [
    `## [${ver}] — ${args.date}`,
    "",
    "Bumps:",
    `- \`@urateam/core\`: ${args.prev.core} → ${args.next.core}`,
    `- \`@urateam/cli\`: ${args.prev.cli} → ${args.next.cli}`,
    `- \`@urateam/dashboard\`: ${args.prev.dashboard} → ${args.next.dashboard}`,
    `- \`create-urateam\`: ${args.prev.createUrateam} → ${args.next.createUrateam}`,
    "",
    "<!-- TODO: replace with ### Added / ### Fixed / ### Chore sections describing this release. -->",
    "",
  ].join("\n");
}

/**
 * Insert a new changelog entry above the latest existing version section.
 * Idempotent: if a section for the same version already exists, returns the
 * input unchanged so half-cut runs can be re-attempted safely.
 */
export function insertChangelogEntry(content: string, entry: string): string {
  const verMatch = /## \[(\d+\.\d+\.\d+)\] —/.exec(entry);
  if (verMatch && content.includes(`## [${verMatch[1]}] —`)) {
    return content;
  }
  const idx = content.search(/^## \[\d+\.\d+\.\d+\] —/m);
  if (idx === -1) return content.trimEnd() + "\n\n" + entry;
  return content.slice(0, idx) + entry + content.slice(idx);
}

/**
 * Compute next release tag from the latest existing tag (e.g. "v0.1.38" → "v0.1.39").
 * Caller passes tags sorted newest-first.
 */
export function nextReleaseTag(latestTags: string[], kind: BumpKind): string {
  const latest = latestTags.find((t) => /^v\d+\.\d+\.\d+$/.test(t));
  const cur = latest ? latest.replace(/^v/, "") : "0.0.0";
  return `v${bumpVersion(cur, kind)}`;
}
