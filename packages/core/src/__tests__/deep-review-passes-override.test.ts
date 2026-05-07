/**
 * BEC-163 — env-var override for `deepReviewPasses` so operators can enable
 * BEC-134 OpenRouter fanout without forking the built-in pipeline configs.
 *
 * Default behavior (env unset) is unchanged: every pipeline keeps its
 * compiled-in `deepReviewPasses` value (0 for the built-ins).
 */
import { describe, it, expect } from "vitest";
import {
  defaultConfigs,
  applyDeepReviewPassesOverride,
} from "../pipeline/config.js";

describe("applyDeepReviewPassesOverride (BEC-163)", () => {
  it("returns configs unchanged when env value is undefined", () => {
    const out = applyDeepReviewPassesOverride(defaultConfigs, undefined);
    expect(out).toEqual(defaultConfigs);
    // Same reference for unchanged map is a nice-to-have but not required.
    for (const [k, cfg] of Object.entries(out)) {
      expect(cfg.deepReviewPasses).toBe(defaultConfigs[k].deepReviewPasses);
    }
  });

  it("sets deepReviewPasses on every pipeline that has a review stage", () => {
    const out = applyDeepReviewPassesOverride(defaultConfigs, "1");
    expect(out["auto-implement"].deepReviewPasses).toBe(1);
    expect(out["bug"].deepReviewPasses).toBe(1);
    expect(out["needs-design"].deepReviewPasses).toBe(1);
  });

  it("does NOT touch pipelines without a review stage (e.g. quick-fix)", () => {
    const out = applyDeepReviewPassesOverride(defaultConfigs, "1");
    // quick-fix has stages: ["implement", "test"] — no review. Fanout would
    // require a review stage to attach to, so the override is meaningless.
    // Leave the default 0 so cost doesn't bump for trivial pipelines.
    expect(out["quick-fix"].deepReviewPasses).toBe(0);
    expect(out["quick-fix"].stages).not.toContain("review");
  });

  it("accepts integer values higher than 1", () => {
    const out = applyDeepReviewPassesOverride(defaultConfigs, "3");
    expect(out["auto-implement"].deepReviewPasses).toBe(3);
  });

  it("accepts 0 to explicitly disable on review-having pipelines", () => {
    // Caller wants to assert: env=0 keeps the default-disabled state but
    // proves the override path executed.
    const out = applyDeepReviewPassesOverride(defaultConfigs, "0");
    expect(out["auto-implement"].deepReviewPasses).toBe(0);
  });

  it("ignores invalid values (non-integer / negative) and returns the input unchanged", () => {
    expect(
      applyDeepReviewPassesOverride(defaultConfigs, "lots")["auto-implement"].deepReviewPasses,
    ).toBe(0);
    expect(
      applyDeepReviewPassesOverride(defaultConfigs, "-1")["auto-implement"].deepReviewPasses,
    ).toBe(0);
    expect(
      applyDeepReviewPassesOverride(defaultConfigs, "")["auto-implement"].deepReviewPasses,
    ).toBe(0);
  });

  it("does not mutate the input map", () => {
    const before = JSON.parse(JSON.stringify(defaultConfigs));
    applyDeepReviewPassesOverride(defaultConfigs, "2");
    expect(defaultConfigs).toEqual(before);
  });
});
