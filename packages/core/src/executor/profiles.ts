import type { AgentProfile } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "executor.profiles" });

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const HAIKU_MODEL = "claude-haiku-4-5";

/**
 * Recursively freeze an object so accidental mutation by callers throws
 * (in strict mode) rather than silently corrupting the shared defaults.
 */
function deepFreeze<T>(o: T): T {
  if (o === null || typeof o !== "object") return o;
  for (const v of Object.values(o as object)) deepFreeze(v);
  return Object.freeze(o);
}

/** Upper bounds for env-var overrides — protect against fat-finger like {"maxTurns": 999999}. */
const MAX_TURNS_CEILING = 500;
const MAX_INPUT_TOKENS_CEILING = 500_000;

/**
 * Default budget + tool surface for each pipeline stage. The defaults are
 * sized for a "mature repo" — implement stage does real work, test stage
 * runs an existing test suite, etc. They are intentionally NOT sized for
 * bootstrapping new infrastructure (e.g., adding vitest + RN test setup
 * from scratch in the test stage), which can blow through the default
 * budget; see urateam#38.
 *
 * Operators with bootstrapping needs can override individual fields per
 * stage via the URATEAM_AGENT_PROFILES env var (see `getAgentProfiles`).
 *
 * Deep-frozen so accidental mutation by a caller (e.g., a test that does
 * `getAgentProfiles().test.maxTurns = 999`) throws instead of silently
 * corrupting the shared defaults for the rest of process lifetime.
 */
export const DEFAULT_AGENT_PROFILES: Record<string, AgentProfile> = deepFreeze({
  triage: {
    tools: ["Read", "Glob", "Grep", "WebSearch"],
    maxInputTokens: 30_000,
    maxTurns: 10,
    model: DEFAULT_MODEL,
  },
  reproduce: {
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    maxInputTokens: 50_000,
    maxTurns: 20,
    model: DEFAULT_MODEL,
  },
  implement: {
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    maxInputTokens: 100_000,
    maxTurns: 50,
    model: DEFAULT_MODEL,
  },
  test: {
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    maxInputTokens: 30_000,
    maxTurns: 25,
    model: HAIKU_MODEL,
  },
  review: {
    tools: ["Read", "Glob", "Grep", "Bash"],
    maxInputTokens: 80_000,
    maxTurns: 20,
    model: DEFAULT_MODEL,
  },
});

/**
 * Backward-compat re-export. Prefer `getAgentProfiles()` so per-process
 * env-var overrides are honored.
 *
 * @deprecated Use `getAgentProfiles()` for active profiles (env-var-merged).
 *   This alias only ever returns the unmerged defaults — useful for
 *   asserting the default shape in tests, but wrong for any consumer
 *   that wants the runtime-effective values.
 */
export const agentProfiles = DEFAULT_AGENT_PROFILES;

let cachedProfiles: Record<string, AgentProfile> | null = null;

interface PartialProfile {
  tools?: unknown;
  maxInputTokens?: unknown;
  maxTurns?: unknown;
  model?: unknown;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isPositiveIntegerWithin(v: unknown, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max;
}

/**
 * Apply a single override object on top of a base profile. Unknown stages
 * are dropped with a warn (op-side typo protection). Known stages with
 * malformed fields are dropped field-by-field (don't let one bad field
 * tank the whole stage). The stage name is included in every warn payload
 * so operators can pinpoint which stage triggered each warning.
 *
 * Returns a fresh object — never mutates `base`. The `tools` array is
 * copied either from the override or from a fresh `[...base.tools]` copy
 * so callers cannot reach back into DEFAULT_AGENT_PROFILES via the
 * returned reference.
 */
function mergeOverride(
  base: AgentProfile,
  override: PartialProfile,
  stage: string,
): AgentProfile {
  const merged: AgentProfile = { ...base, tools: [...base.tools] };
  if (isStringArray(override.tools)) {
    merged.tools = override.tools.slice();
  } else if (override.tools !== undefined) {
    log.warn(
      { stage, field: "tools", got: typeof override.tools },
      "URATEAM_AGENT_PROFILES override: tools must be a string array — ignoring this field",
    );
  }
  if (isPositiveIntegerWithin(override.maxInputTokens, MAX_INPUT_TOKENS_CEILING)) {
    merged.maxInputTokens = override.maxInputTokens;
  } else if (override.maxInputTokens !== undefined) {
    log.warn(
      { stage, field: "maxInputTokens", got: override.maxInputTokens, ceiling: MAX_INPUT_TOKENS_CEILING },
      "URATEAM_AGENT_PROFILES override: maxInputTokens must be a positive integer ≤ ceiling — ignoring this field",
    );
  }
  if (isPositiveIntegerWithin(override.maxTurns, MAX_TURNS_CEILING)) {
    merged.maxTurns = override.maxTurns;
  } else if (override.maxTurns !== undefined) {
    log.warn(
      { stage, field: "maxTurns", got: override.maxTurns, ceiling: MAX_TURNS_CEILING },
      "URATEAM_AGENT_PROFILES override: maxTurns must be a positive integer ≤ ceiling — ignoring this field",
    );
  }
  if (typeof override.model === "string" && override.model.length > 0) {
    merged.model = override.model;
  } else if (override.model !== undefined) {
    log.warn(
      { stage, field: "model", got: override.model },
      "URATEAM_AGENT_PROFILES override: model must be a non-empty string — ignoring this field",
    );
  }
  return merged;
}

/**
 * Return the active per-stage agent profiles. Defaults can be overridden
 * for the current process via the `URATEAM_AGENT_PROFILES` env var, which
 * is parsed as JSON and merged on top of the defaults stage-by-stage:
 *
 *   URATEAM_AGENT_PROFILES='{"test":{"maxTurns":50,"maxInputTokens":80000}}'
 *
 * Only the fields named in the override are changed; everything else keeps
 * its default. Unknown stage names log a warn and are ignored. Malformed
 * fields log a warn and are ignored without dropping the rest of the stage.
 *
 * Result is cached for process lifetime. Call `_resetAgentProfilesCache()`
 * (test-only) to re-read the env var.
 */
export function getAgentProfiles(): Record<string, AgentProfile> {
  if (cachedProfiles) return cachedProfiles;

  const raw = process.env.URATEAM_AGENT_PROFILES;
  if (!raw) {
    cachedProfiles = DEFAULT_AGENT_PROFILES;
    return cachedProfiles;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      "URATEAM_AGENT_PROFILES is not valid JSON — falling back to defaults",
    );
    cachedProfiles = DEFAULT_AGENT_PROFILES;
    return cachedProfiles;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn(
      "URATEAM_AGENT_PROFILES must be a JSON object keyed by stage name — falling back to defaults",
    );
    cachedProfiles = DEFAULT_AGENT_PROFILES;
    return cachedProfiles;
  }

  const overrides = parsed as Record<string, PartialProfile>;
  const result: Record<string, AgentProfile> = { ...DEFAULT_AGENT_PROFILES };
  for (const [stage, override] of Object.entries(overrides)) {
    if (!(stage in DEFAULT_AGENT_PROFILES)) {
      log.warn(
        { stage, knownStages: Object.keys(DEFAULT_AGENT_PROFILES) },
        "URATEAM_AGENT_PROFILES override targets unknown stage — ignoring",
      );
      continue;
    }
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      log.warn(
        { stage, got: typeof override },
        "URATEAM_AGENT_PROFILES per-stage value must be an object — ignoring",
      );
      continue;
    }
    result[stage] = mergeOverride(DEFAULT_AGENT_PROFILES[stage]!, override, stage);
    log.info(
      { stage, profile: result[stage] },
      "URATEAM_AGENT_PROFILES override applied",
    );
  }

  cachedProfiles = result;
  return cachedProfiles;
}

/** Test-only: reset the cached profiles so a new env var value takes effect. */
export function _resetAgentProfilesCache(): void {
  cachedProfiles = null;
}
