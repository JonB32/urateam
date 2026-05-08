/**
 * BEC-178 — env-var override for `autoMerge` so operators can opt every
 * pipeline into auto-merge without forking the built-in pipeline configs.
 *
 * Mirrors the BEC-163 `applyDeepReviewPassesOverride` pattern.
 *
 * Default behavior (env unset) is unchanged: every pipeline keeps its
 * compiled-in `autoMerge` value (undefined / off in the built-ins).
 */
import { describe, it, expect } from "vitest";
import {
  defaultConfigs,
  applyAutoMergeOverride,
} from "../pipeline/config.js";

describe("applyAutoMergeOverride (BEC-178)", () => {
  it("returns configs unchanged when env value is undefined", () => {
    const out = applyAutoMergeOverride(defaultConfigs, undefined);
    expect(out).toEqual(defaultConfigs);
  });

  it("sets autoMerge: true on EVERY pipeline when env is 'true'", () => {
    const out = applyAutoMergeOverride(defaultConfigs, "true");
    expect(out["auto-implement"].autoMerge).toBe(true);
    expect(out["bug"].autoMerge).toBe(true);
    expect(out["needs-design"].autoMerge).toBe(true);
    expect(out["quick-fix"].autoMerge).toBe(true);
  });

  it("sets autoMerge: false on EVERY pipeline when env is 'false' (explicit opt-out)", () => {
    const out = applyAutoMergeOverride(defaultConfigs, "false");
    for (const k of Object.keys(out)) {
      expect(out[k].autoMerge).toBe(false);
    }
  });

  it("is case-insensitive (TRUE / True / true all match)", () => {
    expect(
      applyAutoMergeOverride(defaultConfigs, "TRUE")["auto-implement"].autoMerge,
    ).toBe(true);
    expect(
      applyAutoMergeOverride(defaultConfigs, "True")["auto-implement"].autoMerge,
    ).toBe(true);
    expect(
      applyAutoMergeOverride(defaultConfigs, "FALSE")["auto-implement"].autoMerge,
    ).toBe(false);
  });

  it("ignores invalid values and returns the input unchanged", () => {
    // Non-boolean strings that operators might fat-finger: "yes", "1", "on", ""
    for (const invalid of ["yes", "1", "on", "", "0", "no"]) {
      const out = applyAutoMergeOverride(defaultConfigs, invalid);
      expect(out["auto-implement"].autoMerge).toBe(
        defaultConfigs["auto-implement"].autoMerge,
      );
    }
  });

  it("does not mutate the input map", () => {
    const before = JSON.parse(JSON.stringify(defaultConfigs));
    applyAutoMergeOverride(defaultConfigs, "true");
    expect(defaultConfigs).toEqual(before);
  });

  it("preserves all other pipeline fields when applying the override", () => {
    const out = applyAutoMergeOverride(defaultConfigs, "true");
    // Spot-check that we didn't lose other config (stages, retry, etc.)
    expect(out["auto-implement"].stages).toEqual(
      defaultConfigs["auto-implement"].stages,
    );
    expect(out["auto-implement"].retry).toEqual(
      defaultConfigs["auto-implement"].retry,
    );
    expect(out["auto-implement"].prStrategy).toBe(
      defaultConfigs["auto-implement"].prStrategy,
    );
  });
});
