import { execFile } from "node:child_process";
import { join } from "node:path";
import { access, chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createLogger, getLogContext } from "../logger.js";

const baseLog = createLogger({ component: "git" });

/** Return a logger enriched with the current ALS context (issueId, runId) if present. */
function getLog() {
  const ctx = getLogContext();
  return ctx ? baseLog.child(ctx) : baseLog;
}

/**
 * Normalize a git remote URL for comparison.
 * Strips trailing slashes and .git suffix.
 */
function normalizeGitUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * Execute a git command with the given args in the given cwd.
 * Uses execFile (never exec) to prevent command injection.
 *
 * Per-command execution details are logged at debug level; errors at error level.
 */
export function gitExec(args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  const log = getLog();
  log.debug({ args, cwd }, "git exec");
  return new Promise((resolve, reject) => {
    const proc = execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        log.error({ args, cwd, stderr: stderr?.slice(0, 200) }, `git ${args[0]} failed`);
        reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
      } else {
        log.debug({ args, cwd }, `git ${args[0]} succeeded`);
        resolve(stdout.trim());
      }
    });
    proc.on("exit", (code) => {
      log.debug({ args: args[0], cwd, exitCode: code }, "git process exited");
    });
  });
}

/**
 * Non-throwing variant of gitExec. Returns trimmed stdout on success,
 * empty string on failure. For commands where leading whitespace matters
 * (e.g. git status --porcelain), use gitExecRaw instead.
 */
export async function gitExecSafe(
  args: string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<string> {
  try {
    return await gitExec(args, cwd, timeoutMs);
  } catch {
    return "";
  }
}

/**
 * Like gitExecSafe but preserves leading whitespace in output.
 * Needed for `git status --porcelain` where " M file.txt" has meaningful leading space.
 */
export function gitExecRaw(args: string[], cwd: string, timeoutMs = 15_000): Promise<string> {
  const log = getLog();
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        log.warn({ args: args[0], err: error.message }, "git command failed (non-fatal)");
        resolve("");
      } else {
        resolve(stdout.trimEnd());
      }
    });
  });
}

/**
 * Clone the repo to dir. If dir exists and has the correct remote, run fetchLatest instead.
 */
export async function cloneRepo(url: string, dir: string): Promise<void> {
  try {
    await access(dir);
    // Directory exists — check if it has the correct remote
    try {
      const remote = await gitExec(["remote", "get-url", "origin"], dir);
      if (normalizeGitUrl(remote) === normalizeGitUrl(url)) {
        await fetchLatest(dir);
        return;
      }
    } catch {
      // Not a git repo or no remote — fall through to clone
    }
  } catch {
    // Directory doesn't exist — proceed to clone
  }

  getLog().info({ url, dir }, "cloning repository");
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["clone", url, dir], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`git clone failed: ${stderr || error.message}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Fetch latest from origin.
 */
export async function fetchLatest(repoDir: string): Promise<void> {
  await gitExec(["fetch", "origin"], repoDir);
}

/**
 * Try to add a git worktree. If it fails because the branch is already
 * tied to another worktree, force-remove the stale one and retry once.
 *
 * Git emits TWO different error wordings for this case (urateam#112):
 *   - "fatal: '<branch>' is already checked out at '<path>'"
 *     — fires when the branch is currently checked out in another live
 *     worktree.
 *   - "fatal: '<branch>' is already used by worktree at '<path>'"
 *     — fires when the branch is associated with a worktree even if the
 *     worktree directory has been deleted out from under git. Common
 *     after a previous run completed and the worktree dir was cleaned up
 *     (or rm -rf'd) without `git worktree prune` running.
 *
 * Both are recoverable the same way: remove the stale worktree (force +
 * fall back to rm + prune), retry. The previous version of this function
 * only matched the first wording; the second produced "pipeline failed
 * with unexpected error" on every Linear re-trigger after a completed run.
 */
async function worktreeAddWithRetry(
  repoDir: string,
  args: string[],
  worktreePath: string,
): Promise<void> {
  const log = getLog();
  await gitExec(["worktree", "prune"], repoDir);
  try {
    await gitExec(["worktree", "add", ...args], repoDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already checked out") && !msg.includes("already used by worktree")) {
      throw err;
    }

    // Extract the stale worktree path from either error wording:
    //   "fatal: '<branch>' is already checked out at '<path>'"
    //   "fatal: '<branch>' is already used by worktree at '<path>'"
    const match = msg.match(/already (?:checked out|used by worktree) at '([^']+)'/);
    const stalePath = match?.[1];
    if (stalePath) {
      log.warn({ stalePath, worktreePath }, "removing stale worktree blocking branch checkout");
      try {
        await gitExec(["worktree", "remove", stalePath, "--force"], repoDir);
      } catch {
        // If git worktree remove fails, force-delete the directory
        await rm(stalePath, { recursive: true, force: true });
        await gitExec(["worktree", "prune"], repoDir);
      }
    } else {
      // Can't parse the stale path — just prune and hope
      await gitExec(["worktree", "prune"], repoDir);
    }

    // Retry once
    await gitExec(["worktree", "add", ...args], repoDir);
  }
}

/**
 * Create a git worktree for the given run.
 * Creates branch from HEAD. Returns the worktree path.
 * If the branch is already checked out in a stale worktree, removes it and retries.
 * Also installs a pre-push branch-safety hook in the shared .git directory.
 */
export async function createWorktree(
  repoDir: string,
  runId: string,
  branch: string,
  baseDir: string = "/tmp/agent-runs",
): Promise<string> {
  const worktreePath = join(baseDir, runId, "worktree");
  await worktreeAddWithRetry(repoDir, ["-B", branch, worktreePath], worktreePath);
  // Install pre-push hook to guard against cross-branch contamination (BEC-99).
  await installPrePushHook(repoDir);
  return worktreePath;
}

/**
 * Create a git worktree that checks out an existing remote branch.
 * Used for feedback runs where the PR branch already exists.
 * Fetches origin first, then creates the worktree from origin/<branch>.
 * Returns the worktree path.
 * Also installs a pre-push branch-safety hook in the shared .git directory.
 */
export async function createWorktreeFromRemote(
  repoDir: string,
  runId: string,
  branch: string,
  baseDir: string = "/tmp/agent-runs",
): Promise<string> {
  const worktreePath = join(baseDir, runId, "worktree");
  await gitExec(["fetch", "origin"], repoDir, 60_000);
  await worktreeAddWithRetry(repoDir, ["-B", branch, worktreePath, `origin/${branch}`], worktreePath);
  // Install pre-push hook to guard against cross-branch contamination (BEC-99).
  await installPrePushHook(repoDir);
  return worktreePath;
}

/**
 * Read the current HEAD branch name for a worktree.
 * Returns the branch name (e.g. "agent/BEC-99-foo") or empty string on failure.
 */
export async function getCurrentBranch(worktreePath: string): Promise<string> {
  return gitExecSafe(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
}

/**
 * Verify that the worktree's HEAD is on the expected branch.
 * Throws an Error (and logs) if a mismatch is detected.
 *
 * This is the primary cross-worktree contamination guard: if an agent (or a
 * tool invoked by the agent) ran `git checkout <other-branch>` inside the
 * worktree, any subsequent commit or push would silently land on the wrong
 * branch.  Calling this function before committing or pushing turns the
 * silent data loss into a loud, recoverable error.
 */
export async function verifyBranchMatch(
  worktreePath: string,
  expectedBranch: string,
): Promise<void> {
  const current = await getCurrentBranch(worktreePath);
  if (current && current !== expectedBranch) {
    const msg =
      `Branch mismatch detected in worktree — expected "${expectedBranch}" ` +
      `but HEAD is on "${current}". ` +
      `Aborting to prevent cross-branch contamination.`;
    getLog().error({ worktreePath, expectedBranch, currentBranch: current }, msg);
    throw new Error(msg);
  }
}

/**
 * Install a pre-push git hook in the shared .git directory of the given clone.
 * The hook verifies that the branch being pushed matches the worktree's HEAD,
 * providing a last-line-of-defence against cross-branch contamination.
 *
 * Because all worktrees of a clone share the same .git/hooks/ directory, this
 * hook is installed once per clone — it protects every worktree.
 *
 * The hook is idempotent: if a pre-push hook already exists that was installed
 * by the Linear Agent Framework, it is not overwritten.
 */
export async function installPrePushHook(repoDir: string): Promise<void> {
  const log = getLog();
  // Find the .git directory for this repo (main clone, not a worktree)
  const gitDir = join(repoDir, ".git");
  // For a bare worktree the .git entry is a file, not a directory.
  // We only install the hook in full clones (directory).
  let isGitDir = false;
  try {
    const s = await stat(gitDir);
    isGitDir = s.isDirectory();
  } catch {
    isGitDir = false;
  }
  if (!isGitDir) {
    log.debug({ repoDir }, "installPrePushHook: .git is not a directory (worktree file) — skipping");
    return;
  }

  const hooksDir = join(gitDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");

  // Only install/update if it is our hook or does not yet exist.
  let existing = "";
  try { existing = await import("node:fs/promises").then(({ readFile }) => readFile(hookPath, "utf8")); } catch { /* not found */ }
  if (existing && !existing.includes("# Installed by Linear Agent Framework")) {
    log.debug({ hookPath }, "pre-push hook already exists (not ours) — leaving it in place");
    return;
  }

  const hookScript = [
    "#!/bin/sh",
    "# Installed by Linear Agent Framework (BEC-99)",
    "# Prevents cross-branch contamination when parallel agents share a .git directory.",
    "#",
    "# The hook verifies that every ref being pushed to the remote matches the",
    "# current HEAD branch of this worktree.  If a `git checkout <other-branch>`",
    "# was run inside the worktree, this hook aborts the push immediately.",
    "",
    "while IFS=' ' read -r local_ref _local_sha remote_ref _remote_sha; do",
    "  # remote_ref looks like refs/heads/<branch-name>",
    "  expected_branch=\"${remote_ref#refs/heads/}\"",
    "  current_branch=$(git symbolic-ref --short HEAD 2>/dev/null)",
    "  if [ -n \"$current_branch\" ] && [ \"$current_branch\" != \"$expected_branch\" ]; then",
    "    echo \"ERROR: Linear Agent Framework pre-push hook: branch mismatch detected.\" >&2",
    "    echo \"  HEAD is on : $current_branch\" >&2",
    "    echo \"  Pushing to : $expected_branch\" >&2",
    "    echo \"  Aborting push to prevent cross-branch contamination.\" >&2",
    "    exit 1",
    "  fi",
    "done",
    "",
    "exit 0",
  ].join("\n") + "\n";

  await writeFile(hookPath, hookScript, "utf8");
  await chmod(hookPath, 0o755);
  log.info({ hookPath }, "installed pre-push branch-safety hook");
}

/**
 * Remove a worktree.
 */
export async function deleteWorktree(worktreePath: string): Promise<void> {
  // We need to find the main repo from the worktree, then remove it
  // git worktree remove must be run from the main repo or we can use --force
  await new Promise<void>((resolve, reject) => {
    execFile(
      "git",
      ["worktree", "remove", worktreePath, "--force"],
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `git worktree remove failed: ${stderr || error.message}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
  });
}

/**
 * Push the branch to origin.
 * Verifies that the worktree HEAD is on the expected branch before pushing
 * to prevent cross-branch contamination (BEC-99).
 */
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  await verifyBranchMatch(worktreePath, branch);
  await gitExec(["push", "origin", branch], worktreePath);
}

/**
 * Fetch latest from origin and rebase the current branch on top of
 * origin/<baseBranch>.
 *
 * Returns { success: true } if the rebase applied cleanly.
 * Returns { success: false } if there are unresolved conflicts — the caller
 * must either resolve them (then run `git rebase --continue`) or call
 * abortRebase() before attempting another git operation.
 */
export async function rebaseBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<{ success: boolean; hasConflicts: boolean }> {
  const log = getLog();
  try {
    await gitExec(["fetch", "origin"], worktreePath, 30_000);
  } catch (fetchErr) {
    log.error({ baseBranch, err: fetchErr }, "rebase: fetch failed");
    return { success: false, hasConflicts: false };
  }
  try {
    await gitExec(["rebase", `origin/${baseBranch}`], worktreePath, 60_000);
    return { success: true, hasConflicts: false };
  } catch {
    // Check if a rebase is actually in progress (i.e. conflicts)
    try {
      const status = await gitExec(["status", "--porcelain"], worktreePath, 5_000);
      const hasConflicts = status.includes("UU") || status.includes("AA") || status.includes("DD");
      if (hasConflicts) {
        log.warn({ baseBranch }, "rebase failed — conflicts detected");
      } else {
        log.error({ baseBranch }, "rebase failed — not a conflict (check git state)");
      }
      return { success: false, hasConflicts };
    } catch {
      log.error({ baseBranch }, "rebase failed and could not check status");
      return { success: false, hasConflicts: false };
    }
  }
}

/**
 * Abort an in-progress rebase (non-throwing).
 * Safe to call even when no rebase is in progress.
 */
export async function abortRebase(worktreePath: string): Promise<void> {
  await gitExecSafe(["rebase", "--abort"], worktreePath, 15_000);
}

/**
 * Push the branch to origin using --force-with-lease.
 * Used as a fallback when auto-rebase fails and the pipeline needs to push
 * the original (possibly diverged) branch for human review.
 * Verifies that the worktree HEAD is on the expected branch before pushing
 * to prevent cross-branch contamination (BEC-99).
 *
 * Recovers from "stale info" rejections (urateam#115): when the local
 * tracking ref `refs/remotes/origin/<branch>` points at a commit that
 * no longer exists on origin (because the branch was deleted between
 * runs), force-with-lease can't verify its lease and rejects. Running
 * `git fetch --prune origin` removes stale local tracking refs, after
 * which the lease is either consistent with the new origin state or
 * absent (which is fine — push then creates the branch fresh).
 *
 * Reactive recovery (only fetch+prune on actual failure) matches the
 * existing `worktreeAddWithRetry` pattern from urateam#112 and avoids
 * the network round-trip on the happy path.
 */
export async function pushBranchForce(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const log = getLog();
  await verifyBranchMatch(worktreePath, branch);
  try {
    await gitExec(["push", "origin", branch, "--force-with-lease"], worktreePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("stale info")) throw err;
    log.warn(
      { branch },
      "force-with-lease push rejected with stale info — fetching+pruning origin and retrying (urateam#115)",
    );
    await gitExec(["fetch", "--prune", "origin"], worktreePath);
    // Retry once — if fetch+prune didn't actually clear the staleness
    // (possible only if origin re-created the branch in the same window),
    // bubbling the second failure to the caller is the right outcome.
    await gitExec(["push", "origin", branch, "--force-with-lease"], worktreePath);
  }
}

/**
 * Determines the push strategy for a given branch and rebase state.
 *
 * Returns `"force-with-lease"` when:
 * - The branch name starts with `"agent/"` (pipeline-owned branches that may
 *   have a stale remote ref from a previous failed run), OR
 * - `rebaseConflict` is true (force-push to preserve diverged work for human review).
 *
 * Returns `"standard"` for all other branches (human-owned branches where an
 * accidental force-push could overwrite reviewer commits).
 */
export function choosePushStrategy(
  branch: string,
  rebaseConflict: boolean,
): "force-with-lease" | "standard" {
  if (rebaseConflict || branch.startsWith("agent/")) {
    return "force-with-lease";
  }
  return "standard";
}

/**
 * BEC-157: paths that auto-commit must NEVER include in the agent's commit.
 * These are agent scratchpad / runner-state artifacts that the agent's
 * pipeline produces locally but should not ship to the target repo.
 *
 * Each entry is a predicate against a worktree-relative path. Anchor patterns
 * to root (no leading `/`) so a legitimate `src/utils/verify-input.ts` is not
 * filtered.
 *
 * Trade-off: a legitimate root-level `verify-prod-config.mjs` style script
 * would be silently filtered. Operators with such files must rename them
 * (e.g., `check-prod-config.mjs`) or place them under a subdirectory.
 */
const SCRATCHPAD_PATTERNS: ReadonlyArray<(path: string) => boolean> = [
  // Claude Code session state (runner-specific paths leak in here)
  (p) => p === ".claude" || p.startsWith(".claude/"),
  // Root-level BEC-NNN-*.md docs (agent self-documentation; not repo content)
  (p) => /^BEC-\d+-.*\.md$/.test(p),
  // Root-level verify-*.{mjs,ts,js,cjs} scripts (agent self-validation;
  // redundant with vitest). See trade-off note in docblock above.
  (p) => /^verify-.*\.(mjs|ts|js|cjs)$/.test(p),
  // Root-level BEC-NNN-*-VERIFICATION.md (parallel with BEC-NNN-*.md above —
  // tightened from `[A-Z][A-Z0-9_-]*-VERIFICATION.md` so legitimate operator
  // docs like `SECURITY-VERIFICATION.md` aren't filtered)
  (p) => /^BEC-\d+-.*-VERIFICATION\.md$/.test(p),
];

export function isScratchpadPath(path: string): boolean {
  return SCRATCHPAD_PATTERNS.some((p) => p(path));
}

/**
 * BEC-157: identify scratchpad paths that are ALREADY tracked in HEAD.
 * Returns the subset of `paths` that `git ls-files` reports as tracked.
 *
 * Why: the auto-commit filter unstages scratchpad paths via `git rm --cached`.
 * For a NEWLY-created scratchpad file, this is a clean unstage — no record in
 * HEAD, no harm done. But for a TRACKED file that the agent modified (e.g.,
 * the operator previously committed `.claude/settings.json` before the filter
 * existed), `git rm --cached` records a permanent deletion in the new commit
 * and the file is removed from the repo. That's silent data loss at rollout
 * time on any repo that committed scratchpad pre-filter.
 *
 * This function lets the caller detect the dangerous case and warn / abort.
 */
async function findTrackedPaths(
  worktreePath: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  // `git ls-files -- <paths>` lists only those of the given paths that are
  // tracked. Untracked paths produce no output (they're not errors).
  const out = await gitExecSafe(["ls-files", "--", ...paths], worktreePath);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse `git status --porcelain` output into worktree-relative paths.
 * Handles renames (`R old -> new`), additions, modifications, deletions,
 * and untracked files.
 */
function parseStatusPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain format: XY <space> <path> [-> <newpath>]
    // Examples: " M src/foo.ts", "?? .claude/settings.json", "R  old -> new"
    const rest = line.slice(3);
    if (rest.includes(" -> ")) {
      // Rename: take the new path
      paths.push(rest.split(" -> ")[1]!.trim());
    } else {
      paths.push(rest.trim());
    }
  }
  return paths;
}

/**
 * Check for uncommitted changes and auto-commit them if found.
 * Returns true if a commit was made, false if the worktree was clean.
 *
 * This is a safety net for when the agent doesn't commit its work
 * (hits maxTurns, maxTokens, or a permission error). Without this,
 * the push queue's rebase fails and the work is lost.
 *
 * @param expectedBranch - When provided, the function verifies that the
 *   worktree HEAD is on this branch before committing. A mismatch throws
 *   immediately to prevent cross-branch contamination (BEC-99).
 */
export async function autoCommitChanges(
  worktreePath: string,
  issueId: string,
  expectedBranch?: string,
): Promise<boolean> {
  // Branch-safety guard (BEC-99): verify HEAD before touching the worktree.
  if (expectedBranch) {
    await verifyBranchMatch(worktreePath, expectedBranch);
  }

  const status = await gitExecSafe(["status", "--porcelain"], worktreePath);
  if (!status.trim()) return false;

  // BEC-157: filter out agent scratchpad paths before staging. The pipeline
  // sees them as new files in the worktree (.claude/settings.json with
  // runner paths, BEC-NNN-*.md doc proliferation, verify-*.mjs scripts that
  // duplicate vitest coverage) but they must not be committed to the target
  // repo. Legitimate code under src/ is unaffected.
  const allPaths = parseStatusPaths(status);
  const realPaths = allPaths.filter((p) => !isScratchpadPath(p));
  const filteredPaths = allPaths.filter((p) => isScratchpadPath(p));

  // BEC-157 safety net: if any filtered path is ALREADY TRACKED in HEAD
  // (operator committed it pre-filter, e.g., before this PR shipped),
  // unstaging via `git rm --cached` would record a permanent deletion in the
  // new commit and remove the file from the repo. Detect and skip the unstage
  // for those entries — leaving them staged as legit modifications/additions.
  // Worst case: a tracked scratchpad file gets a normal modify-commit. Better
  // than silent data loss.
  const trackedScratchpad = await findTrackedPaths(worktreePath, filteredPaths);
  const safeToUnstage = filteredPaths.filter((p) => !trackedScratchpad.includes(p));

  if (filteredPaths.length > 0) {
    getLog().info(
      { issueId, filtered: filteredPaths, trackedScratchpad },
      "auto-commit filtered scratchpad paths (BEC-157)",
    );
  }
  if (trackedScratchpad.length > 0) {
    getLog().warn(
      { issueId, trackedScratchpad },
      "auto-commit: scratchpad paths are tracked in HEAD; preserving as committed changes (operator should remove these from the repo manually if unwanted)",
    );
  }

  if (realPaths.length === 0 && trackedScratchpad.length === 0) {
    getLog().warn(
      { issueId, worktreePath, allFiltered: allPaths },
      "auto-commit: no real changes after scratchpad filter (skipping commit)",
    );
    return false;
  }

  getLog().warn({ issueId, worktreePath }, "auto-committing uncommitted changes (agent did not commit)");
  // BEC-157 staging strategy: `git add -A` to correctly handle all status
  // types (modifications, additions, deletions of tracked files, renames),
  // then `git rm --cached` any scratchpad paths that just got staged AND
  // weren't already tracked in HEAD. Using `git add -- <paths>` with an
  // explicit path list looks cleaner but doesn't stage deletions of tracked
  // files (regression caught by the existing "handles deleted files"
  // integration test).
  await gitExecSafe(["add", "-A"], worktreePath);
  if (safeToUnstage.length > 0) {
    // Unstage scratchpad files. `git rm --cached -- <paths>` removes index
    // entries while leaving the worktree files alone. `--ignore-unmatch`
    // tolerates files that weren't tracked yet (untracked scratchpad new
    // files: they were `git add -A`-staged as new index entries, and
    // `git rm --cached` removes them).
    //
    // `-r` is required when filteredPaths includes a directory entry (e.g.,
    // `.claude/` from `git status --porcelain` for a new untracked dir).
    // `--ignore-unmatch` tolerates entries that aren't in the index.
    await gitExecSafe(
      ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...safeToUnstage],
      worktreePath,
    );
  }
  try {
    await gitExec(
      ["commit", "-m", `feat(${issueId}): agent implementation (auto-committed)`],
      worktreePath,
    );
    return true;
  } catch {
    getLog().warn({ issueId }, "auto-commit failed (possibly no changes after git add)");
    return false;
  }
}

/**
 * Get commit subject lines authored on this branch since it diverged from the
 * base branch. Used to include agent-authored commit messages in PR descriptions.
 * Returns commits in chronological order (oldest first).
 * Returns an empty array on failure (fail-open — commit listing is best-effort).
 */
export async function getAgentCommits(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  const log = getLog();
  try {
    // Try using origin first (normal case in production)
    const output = await gitExec(
      ["log", "--format=%s", "--reverse", `origin/${baseBranch}..HEAD`],
      worktreePath,
    );
    return output.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (originErr) {
    // Fall back to local branch (for testing or local-only repos)
    try {
      const output = await gitExec(
        ["log", "--format=%s", "--reverse", `${baseBranch}..HEAD`],
        worktreePath,
      );
      return output.split("\n").map((l) => l.trim()).filter(Boolean);
    } catch {
      log.warn({ baseBranch }, "getAgentCommits failed on both origin and local branch — commit messages will be omitted from PR");
      return [];
    }
  }
}

/**
 * Create a PR using the `gh` CLI. Returns the PR URL.
 * Falls back gracefully — returns empty string if `gh` is not available.
 */
export async function createPRViaCli(options: {
  worktreePath: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  /** GitHub usernames to request review from. */
  reviewers?: string[];
  /** GitHub team slugs (without owner prefix) to request review from. */
  teamReviewers?: string[];
  /**
   * Repo owner — required when `teamReviewers` is supplied because
   * `gh pr create --reviewer` expects `owner/team-slug` for team reviewers.
   */
  owner?: string;
}): Promise<string> {
  const args = [
    "pr", "create",
    "--head", options.branch,
    "--base", options.base,
    "--title", options.title,
    "--body", options.body,
  ];
  if (options.draft) args.push("--draft");
  if (options.reviewers && options.reviewers.length > 0) {
    args.push("--reviewer", options.reviewers.join(","));
  }
  if (options.teamReviewers && options.teamReviewers.length > 0) {
    if (!options.owner) {
      getLog().warn(
        { teamReviewers: options.teamReviewers },
        "createPRViaCli: teamReviewers supplied without owner — skipping team reviewer request",
      );
    } else {
      args.push(
        "--reviewer",
        options.teamReviewers.map((t) => `${options.owner}/${t}`).join(","),
      );
    }
  }

  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      { cwd: options.worktreePath, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          getLog().error({ branch: options.branch, stderr: stderr || error.message }, "gh pr create failed");
          resolve("");
        } else {
          // gh pr create outputs the PR URL on stdout
          resolve(stdout.trim());
        }
      },
    );
  });
}

/**
 * Merge a PR using the `gh` CLI. Returns true on success.
 */
export async function mergePRViaCli(
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "merge", branch, "--merge", "--delete-branch"],
      { cwd: worktreePath, timeout: 30_000 },
      (error, _stdout, stderr) => {
        if (error) {
          getLog().error({ branch, err: stderr || error.message }, "gh pr merge failed");
          resolve(false);
        } else {
          resolve(true);
        }
      },
    );
  });
}

/**
 * Get the list of files changed between the branch and the merge base with the
 * default branch. Used for auto-merge exclusion pattern matching.
 * Returns an empty array on failure (fail-open — pattern matching is best-effort).
 */
export async function getChangedFiles(worktreePath: string, baseBranch: string): Promise<string[]> {
  try {
    const output = await gitExec(
      ["diff", "--name-only", `origin/${baseBranch}...HEAD`],
      worktreePath,
    );
    return output.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch (err) {
    getLog().warn({ baseBranch, err }, "getChangedFiles failed — exclusion patterns will be skipped");
    return [];
  }
}

/**
 * Get the number of changed lines (additions + deletions) between the branch
 * and the merge base with the default branch. This measures the actual PR diff,
 * not uncommitted working tree changes.
 */
export async function getDiffLineCount(worktreePath: string, baseBranch: string): Promise<number> {
  try {
    const stat = await gitExec(
      ["diff", "--shortstat", `origin/${baseBranch}...HEAD`],
      worktreePath,
    );
    // Format: "3 files changed, 10 insertions(+), 5 deletions(-)"
    const insertions = stat.match(/(\d+) insertion/)?.[1] ?? "0";
    const deletions = stat.match(/(\d+) deletion/)?.[1] ?? "0";
    return parseInt(insertions, 10) + parseInt(deletions, 10);
  } catch {
    // Fail-safe: treat git errors as "large diff" to prevent unsafe auto-merge
    return Infinity;
  }
}

/**
 * Check if a branch already exists on the remote for this issue.
 * Uses the repo URL directly (no local clone needed).
 * Returns the branch name if found, null otherwise.
 * Silently returns null on failure (fail-open — dedup is best-effort).
 */
export async function checkDuplicateBranch(
  repoUrl: string,
  issueId: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", "--heads", repoUrl, `refs/heads/agent/${issueId}-*`],
      { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null); // Can't check — proceed without dedup
          return;
        }
        const pattern = `agent/${issueId}-`;
        for (const line of stdout.split("\n")) {
          const ref = line.split("\t")[1]?.replace("refs/heads/", "");
          if (ref?.startsWith(pattern)) {
            resolve(ref);
            return;
          }
        }
        resolve(null);
      },
    );
  });
}

/**
 * Generate a branch name from issue ID and slug.
 */
export function branchName(issueId: string, slug: string): string {
  return `agent/${issueId}-${slug}`;
}

/**
 * BEC-180: run `git worktree prune` only on entries under `baseDir` that have
 * a `.git` entry (file or directory). Sibling dirs that aren't git repos —
 * notably the BEC-174 `.agent-sweep/` parent — are silently skipped instead of
 * producing noisy `level: 50` ERROR logs from `git worktree`'s "not a git
 * repository" complaint.
 *
 * Returns the names that were pruned vs skipped (both relative to baseDir),
 * which makes the function trivially testable.
 */
export async function pruneWorktreesInRepoDirs(
  baseDir: string,
): Promise<{ pruned: string[]; skipped: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return { pruned: [], skipped: [] };
  }

  const pruned: string[] = [];
  const skipped: string[] = [];
  for (const entry of entries) {
    const dir = join(baseDir, entry);
    try {
      // .git can be a directory (regular clone) OR a file (worktree /
      // submodule pointer). `access` succeeds for either.
      await access(join(dir, ".git"));
      await gitExecSafe(["worktree", "prune"], dir);
      pruned.push(entry);
    } catch {
      skipped.push(entry);
    }
  }
  return { pruned, skipped };
}

/**
 * Scan baseDir for run directories (each containing a "worktree" sub-dir) that
 * are older than ttlHours and remove them.  Returns the list of paths removed.
 *
 * TTL is measured against the directory's mtime so that an actively-modified
 * worktree (e.g. still being debugged) resets the clock on every write.
 */
export async function cleanupWorktrees(
  baseDir: string,
  ttlHours: number = 24,
): Promise<string[]> {
  const cleaned: string[] = [];
  const cutoffMs = ttlHours * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    // baseDir does not exist yet — nothing to clean up
    return cleaned;
  }

  const now = Date.now();
  for (const entry of entries) {
    const runDir = join(baseDir, entry);
    try {
      const s = await stat(runDir);
      if (!s.isDirectory()) continue;
      // Safety: only delete directories that contain a "worktree" sub-dir
      // to prevent accidental deletion if AGENT_RUN_DIR is misconfigured
      try { await stat(join(runDir, "worktree")); } catch { continue; }
      const ageMs = now - s.mtimeMs;
      if (ageMs > cutoffMs) {
        await rm(runDir, { recursive: true, force: true });
        getLog().info(
          { runDir, ageHours: Math.floor(ageMs / 3_600_000) },
          "cleaned up stale worktree",
        );
        cleaned.push(runDir);
      }
    } catch (err) {
      getLog().error({ runDir, err }, "failed to remove stale worktree directory");
    }
  }

  return cleaned;
}
