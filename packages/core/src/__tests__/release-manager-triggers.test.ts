import { describe, it, expect } from "vitest";
import {
  evalMergedPRsSince,
  evalTimeSinceLastHours,
  evalCiGreenForMinutes,
  evalRequireSlackApproval,
} from "../release-manager/triggers.js";

describe("evalMergedPRsSince", () => {
  it("passes when count meets threshold", () => {
    expect(evalMergedPRsSince(5, 5)).toEqual({ pass: true, reason: "mergedPRsSince=5 (have 5)" });
    expect(evalMergedPRsSince(7, 5)).toEqual({ pass: true, reason: "mergedPRsSince=5 (have 7)" });
  });
  it("fails when count is below threshold", () => {
    expect(evalMergedPRsSince(3, 5)).toEqual({ pass: false, reason: "mergedPRsSince not met (3/5)" });
    expect(evalMergedPRsSince(0, 1)).toEqual({ pass: false, reason: "mergedPRsSince not met (0/1)" });
  });
});

describe("evalTimeSinceLastHours", () => {
  const now = new Date("2026-05-01T12:00:00Z");

  it("passes when no last tag exists (initial release)", () => {
    expect(evalTimeSinceLastHours(null, 24, now)).toEqual({ pass: true, reason: "no prior tag" });
  });
  it("passes when elapsed >= threshold", () => {
    const lastTag = new Date(now.getTime() - 25 * 3600 * 1000);
    const r = evalTimeSinceLastHours(lastTag, 24, now);
    expect(r.pass).toBe(true);
  });
  it("fails when elapsed < threshold", () => {
    const lastTag = new Date(now.getTime() - 2 * 3600 * 1000);
    const r = evalTimeSinceLastHours(lastTag, 24, now);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/timeSinceLastHours not met/);
  });
});

describe("evalCiGreenForMinutes", () => {
  const now = new Date("2026-05-01T12:00:00Z");

  it("fails when CI is not green", () => {
    expect(evalCiGreenForMinutes("not-green", null, 30, now)).toEqual({
      pass: false,
      reason: "ci_not_green",
    });
  });
  it("fails when CI status is unavailable", () => {
    expect(evalCiGreenForMinutes("unavailable", null, 30, now)).toEqual({
      pass: false,
      reason: "ci_check_unavailable",
    });
  });
  it("fails when green-since is too recent", () => {
    const greenSince = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago
    const r = evalCiGreenForMinutes("green", greenSince, 30, now);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/ciGreenForMinutes not met/);
  });
  it("passes when green long enough", () => {
    const greenSince = new Date(now.getTime() - 45 * 60 * 1000);
    const r = evalCiGreenForMinutes("green", greenSince, 30, now);
    expect(r.pass).toBe(true);
  });
});

describe("evalRequireSlackApproval", () => {
  it("passes when require=false (no-op)", () => {
    expect(evalRequireSlackApproval(false, false)).toEqual({ pass: true, reason: "approval not required" });
  });
  it("passes when require=true and approval is fresh", () => {
    expect(evalRequireSlackApproval(true, true)).toEqual({ pass: true, reason: "approval is fresh" });
  });
  it("fails when require=true and no fresh approval", () => {
    expect(evalRequireSlackApproval(true, false)).toEqual({ pass: false, reason: "no_fresh_approval" });
  });
});
