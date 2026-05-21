/**
 * BEC-227 — Session-volume sanity check.
 *
 * Called at server boot when agent session resume is enabled. Verifies that
 * the Claude Agent SDK's projects directory (where session JSONL transcripts
 * are written) exists on disk and is writeable.
 *
 * When the check fails, the boot path emits a `system.session_volume_warning`
 * audit event and logs a warning — but boot continues. A failing volume
 * check means resumes will silently fall back to fresh sessions; it does NOT
 * mean the daemon can't serve traffic.
 *
 * Reasons:
 *   - `not-found`: the projects directory itself does not exist.
 *   - `write-test-failed`: the directory exists but a probe write threw
 *     (read-only mount, permissions, etc.).
 *   - `tmpfs`: reserved for future platform-specific detection (Linux
 *     `statfs(2)` magic numbers); currently never emitted by this module.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SessionVolumeStatus =
  | { ok: true }
  | { ok: false; reason: "not-found" | "write-test-failed" | "tmpfs" };

/**
 * Checks that the Claude session projects directory is present and writeable.
 *
 * The probe is a tiny `.urateam-volume-probe` file written and immediately
 * unlinked. If either step throws, the volume is treated as non-writeable.
 *
 * @returns A discriminated union describing the result. Callers should treat
 *   any `ok: false` as a warning (log + audit) but not a fatal error.
 */
export function checkSessionVolume(opts: {
  projectsDir: string;
}): SessionVolumeStatus {
  if (!existsSync(opts.projectsDir)) {
    return { ok: false, reason: "not-found" };
  }
  const probe = join(opts.projectsDir, ".urateam-volume-probe");
  try {
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return { ok: true };
  } catch {
    return { ok: false, reason: "write-test-failed" };
  }
}
