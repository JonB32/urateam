import { join } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig } from "../types.js";

// Default to $HOME/data/runs — writable for both root and non-root containers.
// In practice this constant is only used when callers omit baseDir; the
// production pipeline always passes an explicit baseDir derived from the
// AGENT_RUN_DIR env var (see runner.ts). See BEC-152.
const DEFAULT_BASE_DIR = join(homedir(), "data", "runs");

const ALLOWED_DOMAINS = [
  "github.com",
  "api.linear.app",
  "mcp.linear.app",
  "registry.npmjs.org",
  "pypi.org",
];

const DENY_READ = [
  "~/.ssh/*",
  "~/.aws/*",
  "/etc/shadow",
  "~/.claude/*",
];

const DENY_WRITE = [
  "/etc/*",
  "~/.claude/*",
];

/**
 * Creates a sandbox configuration for an agent run.
 * Each run gets an isolated workdir under the base directory.
 */
export function createSandboxConfig(
  runId: string,
  baseDir: string = DEFAULT_BASE_DIR,
): SandboxConfig {
  return {
    workdir: `${baseDir}/${runId}/worktree`,
    allowedDomains: [...ALLOWED_DOMAINS],
    denyRead: [...DENY_READ],
    denyWrite: [...DENY_WRITE],
  };
}
