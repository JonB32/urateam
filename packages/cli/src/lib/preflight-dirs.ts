/**
 * Pre-flight check for AGENT_RUN_DIR and REPO_CLONE_DIR (BEC-152).
 *
 * Creates the directories if they don't exist and verifies they are writable
 * by writing a `.touch` test file. Exits with a clear error message if either
 * directory cannot be created or written to.
 *
 * Fixes BEC-152: default /var paths are not writable in non-root containers.
 */
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export async function preflightDirs(opts: {
  agentRunDir: string;
  repoCloneDir: string;
  command: "ura dev" | "ura start";
}): Promise<void> {
  const { agentRunDir, repoCloneDir, command } = opts;

  for (const [name, dir] of [
    ["AGENT_RUN_DIR", agentRunDir],
    ["REPO_CLONE_DIR", repoCloneDir],
  ] as const) {
    // Step 1: Create directory (mkdir -p equivalent)
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `⚠ Directory setup failed at startup.\n` +
          `  ${name}=${dir} could not be created: ${msg}\n` +
          `  Ensure the path is writable by the current user, or set ${name} to a\n` +
          `  user-writable path (e.g. ${name}=$HOME/data/runs) and restart \`${command}\`.\n`,
      );
      process.exit(1);
    }

    // Step 2: Verify writability by writing a test file
    const touchPath = join(dir, ".touch");
    try {
      writeFileSync(touchPath, "");
      try {
        unlinkSync(touchPath);
      } catch {
        // ignore cleanup failure — the directory is writable, that's what matters
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `⚠ Directory writability check failed at startup.\n` +
          `  ${name}=${dir} exists but is not writable: ${msg}\n` +
          `  Ensure the path is writable by the current user, or set ${name} to a\n` +
          `  user-writable path (e.g. ${name}=$HOME/data/runs) and restart \`${command}\`.\n`,
      );
      process.exit(1);
    }
  }
}
