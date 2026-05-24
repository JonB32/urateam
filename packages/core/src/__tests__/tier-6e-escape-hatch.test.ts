/**
 * BEC-218 — URATEAM_DISABLE_TIER_6E escape hatch for pm.triage_quality_score
 * emission.
 *
 * Tests the isTier6eDisabled() function with all relevant env-var values.
 * The integration path (runner.ts wrapping the emission block) is covered by
 * the isTier6eDisabled call site check — runner.ts calls isTier6eDisabled()
 * before running any of the Tier 6e logic so the entire block is skipped
 * (no parse, no getChangedFiles, no DB write).
 */
import { describe, it, expect } from "vitest";
import { isTier6eDisabled } from "../pm/triage-prediction-quality.js";

describe("isTier6eDisabled", () => {
  it("returns false when env var is unset — emission runs normally", () => {
    expect(isTier6eDisabled({})).toBe(false);
  });

  it("returns true when env var is exactly 'true' — emission skipped", () => {
    expect(isTier6eDisabled({ URATEAM_DISABLE_TIER_6E: "true" })).toBe(true);
  });

  it("returns false for '1' — strict equality does not match", () => {
    expect(isTier6eDisabled({ URATEAM_DISABLE_TIER_6E: "1" })).toBe(false);
  });

  it("returns false for 'yes' — strict equality does not match", () => {
    expect(isTier6eDisabled({ URATEAM_DISABLE_TIER_6E: "yes" })).toBe(false);
  });

  it("returns false for empty string — strict equality does not match", () => {
    expect(isTier6eDisabled({ URATEAM_DISABLE_TIER_6E: "" })).toBe(false);
  });

  it("returns false for 'false' — strict equality does not match", () => {
    expect(isTier6eDisabled({ URATEAM_DISABLE_TIER_6E: "false" })).toBe(false);
  });

  it("returns false for 'TRUE' — strict equality (case-sensitive) does not match", () => {
    expect(isTier6eDisabled({ URATEAM_DISABLE_TIER_6E: "TRUE" })).toBe(false);
  });

  it("uses process.env by default — returns false when var absent from real env", () => {
    // Ensure URATEAM_DISABLE_TIER_6E is not set in our test environment
    const saved = process.env.URATEAM_DISABLE_TIER_6E;
    delete process.env.URATEAM_DISABLE_TIER_6E;
    try {
      expect(isTier6eDisabled()).toBe(false);
    } finally {
      if (saved !== undefined) process.env.URATEAM_DISABLE_TIER_6E = saved;
    }
  });

  it("uses process.env by default — returns true when var is 'true' in real env", () => {
    const saved = process.env.URATEAM_DISABLE_TIER_6E;
    process.env.URATEAM_DISABLE_TIER_6E = "true";
    try {
      expect(isTier6eDisabled()).toBe(true);
    } finally {
      if (saved !== undefined) {
        process.env.URATEAM_DISABLE_TIER_6E = saved;
      } else {
        delete process.env.URATEAM_DISABLE_TIER_6E;
      }
    }
  });
});
