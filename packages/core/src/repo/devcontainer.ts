import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "devcontainer" });

export interface DevcontainerConfig {
  /** Enable devcontainer usage. Default: "auto" (use if .devcontainer exists) */
  mode?: "auto" | "always" | "never";
  /** Override path to devcontainer config */
  configPath?: string;
  /** Extra environment variables for the container */
  env?: Record<string, string>;
}

export interface DevcontainerSession {
  worktreePath: string;
  workspaceFolder: string;
}

function devcontainerExec(
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string }> {
  log.info({ args }, "devcontainer exec");
  return new Promise((resolve, reject) => {
    execFile(
      "devcontainer",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`devcontainer ${args[0]} failed: ${stderr || error.message}`));
        } else {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
      },
    );
  });
}

/**
 * Check if a devcontainer should be used for this worktree.
 */
export async function shouldUseDevcontainer(
  worktreePath: string,
  config?: DevcontainerConfig,
): Promise<boolean> {
  const mode = config?.mode ?? "auto";
  if (mode === "never") return false;
  if (mode === "always") return true;

  // Auto: check if .devcontainer/devcontainer.json exists
  const configPath = config?.configPath ?? ".devcontainer/devcontainer.json";
  try {
    await access(join(worktreePath, configPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build and start the devcontainer. Returns a session handle.
 */
export async function devcontainerUp(
  worktreePath: string,
  config?: DevcontainerConfig,
): Promise<DevcontainerSession> {
  const args = ["up", "--workspace-folder", worktreePath];

  if (config?.configPath) {
    args.push("--config", join(worktreePath, config.configPath));
  }

  log.info({ worktreePath }, "starting container");
  const result = await devcontainerExec(args, worktreePath);

  // devcontainer up outputs JSON with containerID and remoteWorkspaceFolder
  let workspaceFolder = "/workspaces/worktree";
  try {
    const parsed = JSON.parse(result.stdout);
    workspaceFolder = parsed.remoteWorkspaceFolder ?? workspaceFolder;
  } catch {
    // Fall back to default workspace folder
  }

  log.info({ worktreePath, workspaceFolder }, "container started");
  return { worktreePath, workspaceFolder };
}

/**
 * Stop and remove the devcontainer.
 */
export async function devcontainerDown(
  session: DevcontainerSession,
): Promise<void> {
  try {
    await devcontainerExec(
      ["down", "--workspace-folder", session.worktreePath],
      session.worktreePath,
      60_000,
    );
    log.info({ worktreePath: session.worktreePath }, "container stopped");
  } catch (error) {
    log.error({ worktreePath: session.worktreePath, err: error }, "failed to stop container");
  }
}
