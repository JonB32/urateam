import { describe, it, expect } from "vitest";
import { parseStuckRunAgeMinutes } from "../pm/scheduler.js";

describe("PM_AGENT_STUCK_RUN_AGE_MIN default (BEC-227 / BEC-184 tuning)", () => {
  it("default is 120 minutes when env unset", () => {
    expect(parseStuckRunAgeMinutes(undefined)).toBe(120);
  });

  it("default is 120 minutes for invalid string", () => {
    expect(parseStuckRunAgeMinutes("not-a-number")).toBe(120);
  });

  it("default is 120 minutes for empty string", () => {
    expect(parseStuckRunAgeMinutes("")).toBe(120);
  });

  it("env override still respected (valid integer)", () => {
    expect(parseStuckRunAgeMinutes("90")).toBe(90);
  });

  it("zero/negative fall back to default (mis-config guard)", () => {
    expect(parseStuckRunAgeMinutes("0")).toBe(120);
    expect(parseStuckRunAgeMinutes("-5")).toBe(120);
  });

  it("large values pass through", () => {
    expect(parseStuckRunAgeMinutes("1440")).toBe(1440);
  });
});
