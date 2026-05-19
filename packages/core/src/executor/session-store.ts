/**
 * BEC-227 — JSONL transcript access wrapper.
 *
 * The Claude Agent SDK writes each session's transcript to
 *   {projectsRoot}/{encoded-cwd}/{sessionId}.jsonl
 *
 * where `encoded-cwd` is the cwd with slashes replaced by hyphens (per SDK
 * convention; see node_modules/@anthropic-ai/claude-agent-sdk source).
 *
 * urateam uses this wrapper to:
 *   1. Check whether a transcript exists before issuing `query({ resume })`
 *   2. Locate the file for the dashboard's transcript viewer
 *   3. Provide a swap point for future PG-backed session storage (Track E)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * The default projects root used by the SDK. Override via the
 * `URATEAM_CLAUDE_PROJECTS_DIR` env var for tests or non-standard deploys.
 */
export function defaultProjectsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.URATEAM_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

/** Encode a cwd into the SDK's per-project directory name. */
function encodeCwd(cwd: string): string {
  // SDK convention: replace path separators with hyphens, prefix removed if leading slash.
  return cwd.replace(/^\//, "").replace(/[\/\\]/g, "-");
}

/** Build the JSONL transcript path for a given (cwd, sessionId). */
export function transcriptPath(opts: {
  projectsRoot: string;
  cwd: string;
  sessionId: string;
}): string {
  return join(opts.projectsRoot, encodeCwd(opts.cwd), `${opts.sessionId}.jsonl`);
}

/** Returns true iff the transcript file exists on disk. */
export function transcriptExists(opts: {
  projectsRoot: string;
  cwd: string;
  sessionId: string;
}): boolean {
  return existsSync(transcriptPath(opts));
}
