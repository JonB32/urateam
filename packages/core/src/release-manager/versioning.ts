export type BumpPolicy = "patch" | "minor" | "conventional-commits";
export type PrereleaseChannel = "beta" | "rc" | "alpha" | "none";
type BumpKind = "major" | "minor" | "patch";

const BREAKING_SUBJECT_RE = /^(feat|fix|refactor|perf)(\([^)]+\))?!:/m;
const BREAKING_BODY_RE = /BREAKING CHANGE:/m;
const FEAT_SUBJECT_RE = /^feat(\([^)]+\))?:/m;

interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: { channel: string; n: number };
}

function parseSemver(input: string | null): Semver {
  if (!input) return { major: 0, minor: 0, patch: 0 };
  const stripped = input.replace(/^v/, "");
  const m = stripped.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/);
  if (m) {
    const result: Semver = {
      major: parseInt(m[1], 10),
      minor: parseInt(m[2], 10),
      patch: parseInt(m[3], 10),
    };
    if (m[4] && m[5]) {
      result.prerelease = { channel: m[4], n: parseInt(m[5], 10) };
    }
    return result;
  }
  // Fallback for non-standard inputs (e.g. malformed tags)
  const parts = stripped.split(".");
  return {
    major: parseInt(parts[0] ?? "0", 10) || 0,
    minor: parseInt(parts[1] ?? "0", 10) || 0,
    patch: parseInt(parts[2] ?? "0", 10) || 0,
  };
}

function detectKindFromCommits(commits: Array<{ message: string }>): BumpKind {
  let saw: BumpKind = "patch";
  for (const c of commits) {
    const msg = c.message ?? "";
    if (BREAKING_SUBJECT_RE.test(msg) || BREAKING_BODY_RE.test(msg)) return "major";
    if (FEAT_SUBJECT_RE.test(msg)) saw = "minor";
  }
  return saw;
}

function applyBump(v: Semver, kind: BumpKind): Semver {
  if (kind === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (kind === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

/** Returns true when tag contains a prerelease segment (e.g. "v1.2.3-beta.1"). */
export function isPrereleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+-[a-z]+\.\d+$/.test(tag);
}

/**
 * Compute the next semver tag given the current tag, commits, bump policy, and
 * optional pre-release channel.
 *
 *   - channel "none" (default): standard semver bump; if current tag is a
 *     prerelease, strips the suffix (promotion: v1.2.4-beta.5 → v1.2.4).
 *   - channel "beta"/"rc"/"alpha": emits vX.Y.Z-<channel>.N; increments N
 *     when the current tag already carries the same channel, otherwise bumps
 *     the base version and starts at N=1.
 *
 * Major bumps are ONLY produced by "conventional-commits". "patch" and
 * "minor" never escalate to major — protects against runaway breaking
 * releases from config alone (per spec §8 + D4).
 *
 * Returns the next tag with a leading "v".
 */
export function bumpFromConfigAndCommits(
  current: string | null,
  commits: Array<{ message: string }>,
  policy: BumpPolicy,
  prereleaseChannel: PrereleaseChannel = "none",
): string {
  const v = parseSemver(current);
  let kind: BumpKind;
  if (policy === "patch") kind = "patch";
  else if (policy === "minor") kind = "minor";
  else kind = detectKindFromCommits(commits);

  if (prereleaseChannel === "none") {
    // Promotion path: if last tag was a prerelease, strip the channel suffix.
    if (v.prerelease) {
      return `v${v.major}.${v.minor}.${v.patch}`;
    }
    const next = applyBump(v, kind);
    return `v${next.major}.${next.minor}.${next.patch}`;
  }

  // Same channel → increment N without bumping the base version.
  if (v.prerelease && v.prerelease.channel === prereleaseChannel) {
    return `v${v.major}.${v.minor}.${v.patch}-${prereleaseChannel}.${v.prerelease.n + 1}`;
  }

  // Different channel or no prerelease: bump the base version, start at N=1.
  const base: Semver = { major: v.major, minor: v.minor, patch: v.patch };
  const next = applyBump(base, kind);
  return `v${next.major}.${next.minor}.${next.patch}-${prereleaseChannel}.1`;
}
