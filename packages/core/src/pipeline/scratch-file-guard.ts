/**
 * Tier 1a — scratch-file denylist gate.
 *
 * Wired into the pipeline runner right before push (alongside the org-policy
 * gate). Scans for added files matching a denylist of "agent self-documentation"
 * artifacts (FINAL_CHECKLIST.md, commit-test-changes.sh, TESTING_COMPLETE.md,
 * *.bak, untracked *.log, etc.) that historically slip past auto-commit and
 * ship in PRs.
 *
 * On a match, the runner pushes a `category: "scratch-files"` blocking
 * `ReviewFinding` and forces the PR to draft. The operator decides whether to
 * delete; the gate never auto-deletes.
 *
 * Escape hatch: `URATEAM_DISABLE_SCRATCH_GUARD=true`.
 *
 * The matcher is a pure function (`matchScratchPatterns`) so it is unit-
 * testable without git; the git layer (`enumerateAddedFiles`) is exercised by
 * the runner-level integration. See `__tests__/scratch-file-guard.test.ts`.
 */
import { gitExecSafe } from "../repo/git.js";

/**
 * Repo-root markdown files that are legitimate project documentation. New
 * markdown at the repo root NOT in this set is treated as a scratch artifact.
 * Match is case-insensitive on the basename.
 */
const ROOT_MARKDOWN_EXEMPTIONS = new Set<string>(
  [
    "README.md",
    "CLAUDE.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "LICENSE.md",
    "AUTHORS.md",
  ].map((s) => s.toLowerCase()),
);

/**
 * Denylist patterns. Each predicate runs against a worktree-relative path.
 * Order matters: the first match wins (paths are reported once even if they
 * match multiple patterns).
 *
 * Patterns are intentionally narrow to keep the false-positive rate low —
 * exemptions cover the standard project-documentation roster. If a legitimate
 * file is matched, the operator can rename it or set
 * `URATEAM_DISABLE_SCRATCH_GUARD=true` for the affected run.
 */
const SCRATCH_PATTERNS: ReadonlyArray<{
  name: string;
  test: (path: string) => boolean;
}> = [
  // *.bak and *.bak.* anywhere in the tree (config.bak.20260511, foo.ts.bak).
  { name: "bak", test: (p) => /\.bak(\.[^/]+)?$/i.test(p) },
  // Repo-root summary / report / checklist markdown the agent generates as
  // self-narrative. Anchored to no slashes so subdirectory docs are exempt.
  {
    name: "report-md",
    test: (p) =>
      /^[^/]+$/.test(p) &&
      (/^TEST_.*\.md$/i.test(p) ||
        /^TESTING_.*\.md$/i.test(p) ||
        /^FINAL_.*\.md$/i.test(p) ||
        /_REPORT\.md$/i.test(p) ||
        /_CHECKLIST\.md$/i.test(p)),
  },
  // Repo-root one-off shell scripts (commit-test.sh, run-verification.sh).
  // Nested scripts/setup.sh, deploy/restart.sh, etc. are exempt.
  {
    name: "root-shell",
    test: (p) => /^(commit|run)-[^/]*\.sh$/i.test(p),
  },
  // *.tmp and *.log anywhere in the diff. .log included as denylist because
  // any committed log file is almost certainly a stray run artifact; if a
  // project legitimately tracks logs (rare), the escape hatch handles it.
  { name: "tmp", test: (p) => /\.tmp$/i.test(p) },
  { name: "log", test: (p) => /\.log$/i.test(p) },
  // Any new repo-root *.md NOT in the standard project-documentation set.
  // This is the catch-all for "agent wrote a summary at the root". Runs last
  // so the more-specific TEST_/FINAL_/_REPORT/_CHECKLIST patterns take precedence
  // (purely cosmetic — the same path is flagged either way).
  {
    name: "root-md-non-exempt",
    test: (p) => {
      if (!/^[^/]+\.md$/i.test(p)) return false;
      const lower = p.toLowerCase();
      return !ROOT_MARKDOWN_EXEMPTIONS.has(lower);
    },
  },
];

/**
 * Pure matcher: given a list of worktree-relative paths, return the subset
 * that match any scratch pattern, in input order, deduplicated.
 *
 * Exported for unit testing. The runner calls `findScratchFiles` instead,
 * which wraps this with the git query and the escape-hatch env var.
 */
export function matchScratchPatterns(paths: string[]): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    if (SCRATCH_PATTERNS.some((pat) => pat.test(p))) {
      seen.add(p);
      matches.push(p);
    }
  }
  return matches;
}

/**
 * Enumerate paths added in the current branch relative to `origin/<baseBranch>`,
 * including both committed adds (the common case after auto-commit) and any
 * stray uncommitted/untracked files (belt-and-suspenders).
 *
 * Returns an empty array on git failure (fail-open — the gate is best-effort,
 * not a hard correctness boundary).
 */
async function enumerateAddedFiles(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  const seen = new Set<string>();

  // Committed adds against the remote base. Use `origin/<base>...HEAD` (three
  // dots) to compute against the merge-base, mirroring `getChangedFiles`.
  const diffOut = await gitExecSafe(
    [
      "diff",
      "--name-only",
      "--diff-filter=A",
      `origin/${baseBranch}...HEAD`,
    ],
    worktreePath,
  );
  for (const line of diffOut.split("\n")) {
    const p = line.trim();
    if (p) seen.add(p);
  }

  // Uncommitted/untracked. Porcelain `??` (untracked) or `A ` (staged add).
  const statusOut = await gitExecSafe(["status", "--porcelain"], worktreePath);
  for (const line of statusOut.split("\n")) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (xy === "??" || xy.includes("A")) {
      const p = rest.includes(" -> ") ? rest.split(" -> ")[1]!.trim() : rest.trim();
      if (p) seen.add(p);
    }
  }

  return [...seen];
}

export interface ScratchFileResult {
  /** Worktree-relative paths that matched the denylist, deduplicated. */
  files: string[];
  /** True when `URATEAM_DISABLE_SCRATCH_GUARD=true` short-circuited the gate. */
  skipped: boolean;
}

/**
 * Public entry point. Runs the gate against the worktree at `worktreePath`,
 * with `baseBranch` as the comparison point (typically the repo's default
 * branch). Honors `URATEAM_DISABLE_SCRATCH_GUARD=true` as an escape hatch.
 */
export async function findScratchFiles(
  worktreePath: string,
  baseBranch: string,
): Promise<ScratchFileResult> {
  if (process.env.URATEAM_DISABLE_SCRATCH_GUARD === "true") {
    return { files: [], skipped: true };
  }
  const candidates = await enumerateAddedFiles(worktreePath, baseBranch);
  return { files: matchScratchPatterns(candidates), skipped: false };
}
