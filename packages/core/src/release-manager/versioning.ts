export type BumpPolicy = "patch" | "minor" | "conventional-commits";
type BumpKind = "major" | "minor" | "patch";

const BREAKING_SUBJECT_RE = /^(feat|fix|refactor|perf)(\([^)]+\))?!:/m;
const BREAKING_BODY_RE = /BREAKING CHANGE:/m;
const FEAT_SUBJECT_RE = /^feat(\([^)]+\))?:/m;

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(input: string | null): Semver {
  if (!input) return { major: 0, minor: 0, patch: 0 };
  const stripped = input.replace(/^v/, "");
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

/**
 * Compute the next semver tag given the current tag, the commits since it,
 * and the configured bump policy.
 *
 *   - "patch":  always patch bump
 *   - "minor":  always minor bump (patch resets to 0)
 *   - "conventional-commits": scan commit messages — major on BREAKING/!,
 *                             minor on any feat:, else patch.
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
): string {
  const v = parseSemver(current);
  let kind: BumpKind;
  if (policy === "patch") kind = "patch";
  else if (policy === "minor") kind = "minor";
  else kind = detectKindFromCommits(commits);

  const next = applyBump(v, kind);
  return `v${next.major}.${next.minor}.${next.patch}`;
}
