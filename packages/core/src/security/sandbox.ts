import type { SandboxConfig } from "../types.js";

const DEFAULT_BASE_DIR = "/var/agent-runs";

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
