/**
 * BEC-236 — parse the half-open circuit-breaker probe configuration from
 * environment variables. Read at call time (not boot time) so flipping
 * `PM_DISABLE_CIRCUIT_BREAKER_PROBE` takes effect on the next PM tick
 * without a daemon restart, matching the BEC-218 / BEC-227 convention.
 */
export interface CircuitBreakerProbeConfig {
  disabled: boolean;
  cooldownMs: number;
  maxProbesPerTick: number;
}

const DEFAULT_COOLDOWN_MIN = 120;
const DEFAULT_MAX_PROBES_PER_TICK = 2;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function getCircuitBreakerProbeConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): CircuitBreakerProbeConfig {
  // Strict equality — matches the BEC-218 / BEC-227 convention for booleans
  // ("1" / "yes" / "TRUE" must NOT match).
  const disabled = env.PM_DISABLE_CIRCUIT_BREAKER_PROBE === "true";
  const cooldownMin = parsePositiveInt(env.PM_CIRCUIT_BREAKER_PROBE_AGE_MIN, DEFAULT_COOLDOWN_MIN);
  const maxProbesPerTick = parsePositiveInt(
    env.PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK,
    DEFAULT_MAX_PROBES_PER_TICK,
  );
  return {
    disabled,
    cooldownMs: cooldownMin * 60 * 1000,
    maxProbesPerTick,
  };
}
