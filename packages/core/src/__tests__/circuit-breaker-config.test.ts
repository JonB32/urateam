import { describe, it, expect } from "vitest";
import { getCircuitBreakerProbeConfig } from "../pm/actions/circuit-breaker-config.js";

describe("getCircuitBreakerProbeConfig", () => {
  it("returns defaults when env is empty", () => {
    expect(getCircuitBreakerProbeConfig({})).toEqual({
      disabled: false,
      cooldownMs: 120 * 60 * 1000,
      maxProbesPerTick: 2,
    });
  });

  it("disabled is true ONLY for strict 'true'", () => {
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "true" }).disabled).toBe(true);
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "1" }).disabled).toBe(false);
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "yes" }).disabled).toBe(false);
    expect(getCircuitBreakerProbeConfig({ PM_DISABLE_CIRCUIT_BREAKER_PROBE: "TRUE" }).disabled).toBe(false);
  });

  it("parses PM_CIRCUIT_BREAKER_PROBE_AGE_MIN as minutes", () => {
    expect(getCircuitBreakerProbeConfig({ PM_CIRCUIT_BREAKER_PROBE_AGE_MIN: "30" }).cooldownMs).toBe(30 * 60 * 1000);
  });

  it("parses PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK", () => {
    expect(getCircuitBreakerProbeConfig({ PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK: "5" }).maxProbesPerTick).toBe(5);
  });

  it("falls back to defaults on non-integer values", () => {
    const cfg = getCircuitBreakerProbeConfig({
      PM_CIRCUIT_BREAKER_PROBE_AGE_MIN: "abc",
      PM_CIRCUIT_BREAKER_MAX_PROBES_PER_TICK: "-1",
    });
    expect(cfg.cooldownMs).toBe(120 * 60 * 1000);
    expect(cfg.maxProbesPerTick).toBe(2);
  });
});
