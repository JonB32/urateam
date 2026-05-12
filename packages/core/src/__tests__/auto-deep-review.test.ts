/**
 * Tier 3 — auto-deep-review thresholds.
 *
 * Promotes the deep-review fanout (`deepReviewPasses`) from opt-in to default
 * for PRs above heuristic thresholds. The decision logic is a pure function
 * so the existing runner integration tests don't need new mocking
 * scaffolding — Tier 3 only changes the value passed to the existing deep-
 * review loop.
 *
 * Three thresholds (any one trips):
 *   • newFiles ≥ N        — heuristic for "non-trivial" diff
 *   • totalLines ≥ N      — measures actual diff size
 *   • newPublicExports ≥ N — surface-area changes (new functions/types)
 *
 * Defaults: { newFiles: 5, totalLines: 200, newPublicExports: 2 }.
 *
 * Two escape hatches:
 *   1. `URATEAM_DISABLE_AUTO_DEEP_REVIEW=true` short-circuits the heuristic.
 *   2. Per-pipeline `autoDeepReviewThresholds: { newFiles: 999999, ... }`
 *      effectively raises the bar to disable.
 *
 * Deep-review findings are blocking-by-default (Tier 3 design); the
 * existing review-fix loop already escalates blocking findings, so the
 * runner wires `deepReviewFindingsAreBlocking` into a follow-up flag the
 * deep-review loop already supports.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  countNewPublicExports,
  shouldAutoDeepReview,
  DEFAULT_AUTO_DEEP_REVIEW_THRESHOLDS,
} from "../pipeline/auto-deep-review.js";

describe("countNewPublicExports — parses diff for added `^export ...` lines", () => {
  it("counts a single added function export", () => {
    const diff = `
diff --git a/packages/core/src/util/x.ts b/packages/core/src/util/x.ts
index 0000000..1111111 100644
--- a/packages/core/src/util/x.ts
+++ b/packages/core/src/util/x.ts
@@ -0,0 +1,3 @@
+export function foo() {
+  return 1;
+}
`;
    expect(countNewPublicExports(diff)).toBe(1);
  });

  it("counts class, const, let, interface, type, enum exports — but not import-style", () => {
    const diff = `
+++ b/packages/core/src/a.ts
@@ -0,0 +1,8 @@
+export class A {}
+export const b = 1;
+export let c = 2;
+export interface D {}
+export type E = string;
+export enum F { x }
+export async function g() {}
+import { something } from './x';
`;
    expect(countNewPublicExports(diff)).toBe(7);
  });

  it("excludes deletions (lines starting with `-export ...`)", () => {
    const diff = `
+++ b/packages/core/src/a.ts
@@ -1,4 +1,2 @@
-export function gone() {}
-export const old = 1;
+export function kept() {}
`;
    expect(countNewPublicExports(diff)).toBe(1);
  });

  it("ignores context lines that happen to start with `export`", () => {
    // Context lines start with a single space in unified diff; `+export` is
    // added, `export` (no `+`) is context.
    const diff = `
+++ b/packages/core/src/a.ts
@@ -1,3 +1,3 @@
 export function unchanged() {
   return 1;
 }
`;
    expect(countNewPublicExports(diff)).toBe(0);
  });

  it("only counts paths under packages/*/src/ — excludes tests and docs", () => {
    const diff = `
+++ b/packages/core/src/foo.ts
@@ -0,0 +1,1 @@
+export function inSrc() {}
+++ b/packages/core/src/__tests__/foo.test.ts
@@ -0,0 +1,1 @@
+export function inTests() {}
+++ b/docs/foo.md
@@ -0,0 +1,1 @@
+export function inDocs() {}
+++ b/scripts/x.ts
@@ -0,0 +1,1 @@
+export function inScripts() {}
`;
    expect(countNewPublicExports(diff)).toBe(1);
  });

  it("returns 0 for an empty diff", () => {
    expect(countNewPublicExports("")).toBe(0);
  });
});

describe("shouldAutoDeepReview — fires when any threshold trips", () => {
  const ENV_KEY = "URATEAM_DISABLE_AUTO_DEEP_REVIEW";
  beforeEach(() => {
    delete process.env[ENV_KEY];
  });
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("trips on newFiles >= threshold (5 by default)", () => {
    expect(
      shouldAutoDeepReview({
        newFiles: 5,
        totalLines: 0,
        newPublicExports: 0,
      }),
    ).toBe(true);
    expect(
      shouldAutoDeepReview({
        newFiles: 4,
        totalLines: 0,
        newPublicExports: 0,
      }),
    ).toBe(false);
  });

  it("trips on totalLines >= threshold (200 by default)", () => {
    expect(
      shouldAutoDeepReview({
        newFiles: 0,
        totalLines: 200,
        newPublicExports: 0,
      }),
    ).toBe(true);
    expect(
      shouldAutoDeepReview({
        newFiles: 0,
        totalLines: 199,
        newPublicExports: 0,
      }),
    ).toBe(false);
  });

  it("trips on newPublicExports >= threshold (2 by default)", () => {
    expect(
      shouldAutoDeepReview({
        newFiles: 0,
        totalLines: 0,
        newPublicExports: 2,
      }),
    ).toBe(true);
    expect(
      shouldAutoDeepReview({
        newFiles: 0,
        totalLines: 0,
        newPublicExports: 1,
      }),
    ).toBe(false);
  });

  it("does NOT trip on a clean diff (all below threshold)", () => {
    expect(
      shouldAutoDeepReview({
        newFiles: 1,
        totalLines: 10,
        newPublicExports: 0,
      }),
    ).toBe(false);
  });

  it("honors per-pipeline threshold overrides (e.g. set to 999999 to disable)", () => {
    expect(
      shouldAutoDeepReview(
        { newFiles: 100, totalLines: 10_000, newPublicExports: 100 },
        { newFiles: 999_999, totalLines: 999_999, newPublicExports: 999_999 },
      ),
    ).toBe(false);
  });

  it("URATEAM_DISABLE_AUTO_DEEP_REVIEW=true short-circuits the heuristic", () => {
    process.env[ENV_KEY] = "true";
    expect(
      shouldAutoDeepReview({
        newFiles: 1000,
        totalLines: 1_000_000,
        newPublicExports: 1000,
      }),
    ).toBe(false);
  });

  it("env-var values other than 'true' do NOT disable", () => {
    for (const v of ["false", "0", "", "yes", "1"]) {
      process.env[ENV_KEY] = v;
      expect(
        shouldAutoDeepReview({
          newFiles: 5,
          totalLines: 0,
          newPublicExports: 0,
        }),
        `env=${v}`,
      ).toBe(true);
    }
  });
});

describe("DEFAULT_AUTO_DEEP_REVIEW_THRESHOLDS — matches the operator brief", () => {
  it("has the documented defaults", () => {
    expect(DEFAULT_AUTO_DEEP_REVIEW_THRESHOLDS).toEqual({
      newFiles: 5,
      totalLines: 200,
      newPublicExports: 2,
    });
  });
});
