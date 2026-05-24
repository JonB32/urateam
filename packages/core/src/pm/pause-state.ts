/**
 * PM Agent pause state — single-process shared mutable state for the pause/resume
 * Slack commands. Extracted to a micro-module so that `slack-commands.ts` can read
 * and write the flag without importing from `slack-interface.ts`, which would create
 * a circular dependency (slack-interface imports slack-commands; slack-commands must
 * not import back from slack-interface).
 *
 * Note: single-process only. For multi-process deploys, replace with a Redis-backed
 * implementation.
 */

let paused = false;

/**
 * Returns `true` if the PM Agent is currently paused.
 *
 * Pause is active when EITHER of the following is true (OR logic):
 * - `process.env.PM_AGENT_PAUSED === "true"` — env-var path for no-Slack incident
 *   response. Toggling requires a container restart (env vars are read at each
 *   tick invocation, not at module load time).
 * - `setPmPaused(true)` has been called via the Slack `/pm pause` command.
 *
 * The env-var takes priority: setting `PM_AGENT_PAUSED=true` keeps the agent
 * paused even if `setPmPaused(false)` is subsequently called via Slack.
 */
export function isPmPaused(): boolean {
  return process.env.PM_AGENT_PAUSED === "true" || paused;
}

/**
 * Sets the Slack-driven pause flag. Use `setPmPaused(true)` when the user
 * sends `/pm pause` and `setPmPaused(false)` for `/pm resume`.
 */
export function setPmPaused(value: boolean): void {
  paused = value;
}
