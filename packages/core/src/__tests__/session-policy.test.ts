import { describe, it, expect } from "vitest";
import { isResumable, isAlwaysFreshStage, ALWAYS_FRESH_STAGES } from "../executor/session-policy.js";

describe("session-policy (BEC-227)", () => {
  describe("isAlwaysFreshStage", () => {
    it("validate stage is always fresh", () => {
      expect(isAlwaysFreshStage("validate")).toBe(true);
    });
    it("ralph-check stage is always fresh", () => {
      expect(isAlwaysFreshStage("ralph-check")).toBe(true);
    });
    it("implement stage is NOT always fresh", () => {
      expect(isAlwaysFreshStage("implement")).toBe(false);
    });
    it("ALWAYS_FRESH_STAGES set is exposed and immutable from caller's perspective", () => {
      expect(ALWAYS_FRESH_STAGES.has("validate")).toBe(true);
      expect(ALWAYS_FRESH_STAGES.has("implement")).toBe(false);
    });
  });

  describe("isResumable", () => {
    it("Sonnet on implement → resumable", () => {
      expect(isResumable("implement", "claude-sonnet-4-6")).toBe(true);
    });
    it("Opus on implement → resumable (same family)", () => {
      expect(isResumable("implement", "claude-opus-4-7")).toBe(true);
    });
    it("Haiku on implement → not resumable (different family)", () => {
      expect(isResumable("implement", "claude-haiku-4-5")).toBe(false);
    });
    it("any model on validate → not resumable", () => {
      expect(isResumable("validate", "claude-sonnet-4-6")).toBe(false);
    });
    it("Sonnet on review → resumable", () => {
      expect(isResumable("review", "claude-sonnet-4-6")).toBe(true);
    });
    it("Sonnet on deep-review → resumable", () => {
      expect(isResumable("deep-review", "claude-sonnet-4-6")).toBe(true);
    });
    it("non-Claude model → not resumable", () => {
      expect(isResumable("review", "qwen/qwen-3-plus")).toBe(false);
      expect(isResumable("review", "openai/gpt-oss-120b")).toBe(false);
    });
  });
});
