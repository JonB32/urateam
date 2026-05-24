/**
 * BEC-227 — Session resume policy.
 *
 * Determines, for a given (stage, model) pair, whether the pipeline runner
 * should resume the per-run SDK session (`query({ resume: sessionId })`) or
 * start fresh (`query({ sessionId })` for the first stage, or no session opts
 * at all for always-fresh stages).
 *
 * The policy is static, not config — operators can change `stageModels` but
 * cannot override which stages are always-fresh. This prevents the Haiku
 * validator from inheriting a Sonnet implement's tool-call history, which
 * is wasteful and potentially confusing.
 */

/** Stages that always run with a fresh SDK session, regardless of model. */
export const ALWAYS_FRESH_STAGES: ReadonlySet<string> = new Set([
  "validate", // Haiku handoff validator (executor/validate.ts)
  "ralph-check", // Haiku ralph requirements checker (executor/ralph.ts)
]);

/** Returns true when the given stage is in the always-fresh set. */
export function isAlwaysFreshStage(stage: string): boolean {
  return ALWAYS_FRESH_STAGES.has(stage);
}

/**
 * Returns the model family.
 *
 * - "claude-sonnet-*" / "claude-opus-*" → "claude" (resumable family)
 * - "claude-haiku-*" → "haiku" (treated as a distinct family; the Haiku
 *   stages are also in ALWAYS_FRESH_STAGES, so cross-stage Haiku overrides
 *   via `stageModels` still get a fresh session)
 * - anything else (e.g., qwen/*, openai/*) → "other" (OpenRouter fanout
 *   providers — can't share an SDK session)
 */
function modelFamily(model: string): "claude" | "haiku" | "other" {
  if (model.startsWith("claude-haiku")) return "haiku";
  if (model.startsWith("claude-")) return "claude";
  return "other";
}

/**
 * Returns true iff the given stage running on the given model should resume
 * the per-run SDK session.
 *
 * Rule: stage is NOT in the always-fresh set AND model is a resumable Claude
 * family (sonnet/opus). Cross-family (e.g., implement-on-Haiku via
 * stageModels override) falls back to fresh, since the Haiku stages drive
 * the always-fresh policy and we don't want to bind the per-run session to
 * a Haiku transcript.
 */
export function isResumable(stage: string, model: string): boolean {
  if (isAlwaysFreshStage(stage)) return false;
  return modelFamily(model) === "claude";
}

/**
 * Returns true iff agent session resume (BEC-227) is enabled for this run.
 *
 * BEC-227 Phase 3: default ON. After the Phase 2 dogfood soak verified the
 * mechanism works end-to-end (combined with the BEC-231 + BEC-232 fixes),
 * the default flipped from opt-in to opt-out. Operators who want to disable
 * session resume can set `URATEAM_DISABLE_AGENT_SESSION_RESUME=true`.
 *
 * Strict equality on `"true"` — mirrors BEC-218 precedent so `"1"` /
 * `"yes"` / `"TRUE"` / `""` do NOT disable the flag. The env is read at
 * call time so flipping the var takes effect on the next pipeline run
 * without a daemon restart.
 *
 * The previous Phase-1/2 env var `URATEAM_ENABLE_AGENT_SESSION_RESUME` is
 * ignored under Phase 3. Operators with `URATEAM_ENABLE_AGENT_SESSION_RESUME=true`
 * in their `.env` will see no behavior change (the new default is on);
 * operators relying on the old default-off can switch to
 * `URATEAM_DISABLE_AGENT_SESSION_RESUME=true`.
 */
export function isAgentSessionResumeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.URATEAM_DISABLE_AGENT_SESSION_RESUME !== "true";
}
