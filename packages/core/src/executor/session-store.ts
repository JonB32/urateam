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

/**
 * Encode a cwd into the SDK's per-project directory name.
 *
 * BEC-232 — match the SDK's encoding exactly. The SDK replaces ALL path
 * separators (including a leading `/`) with `-`, producing a directory name
 * like `"-home-ura-data-runs-<run>-worktree"` (note the LEADING dash).
 *
 * The pre-BEC-232 implementation stripped the leading `/` BEFORE replacing,
 * producing `"home-..."` (no leading dash). The mismatch caused
 * `transcriptExists()` to always return false for absolute cwds — every
 * BEC-227 session-resume attempt fell back to legacy handoff because
 * urateam looked for the JSONL at the wrong path. Verified on the dogfood
 * instance against real SDK-written transcripts (BEC-231 soak observation).
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[\/\\]/g, "-");
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

/**
 * Compute the transcript path and check existence in a single call, encoding
 * the cwd only once. Callers that need both the path (for readFileSync) and
 * the existence check should prefer this over calling transcriptExists() then
 * transcriptPath() separately.
 */
export function resolveTranscript(opts: {
  projectsRoot: string;
  cwd: string;
  sessionId: string;
}): { path: string; exists: boolean } {
  const path = transcriptPath(opts);
  return { path, exists: existsSync(path) };
}
