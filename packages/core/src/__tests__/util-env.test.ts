import { describe, it, expect } from "vitest";
import { parseIntOr, parseFloatOr, parsePositiveIntOrUndefined } from "../util/env.js";

describe("parseIntOr", () => {
  it("returns fallback for undefined", () => {
    expect(parseIntOr(undefined, 10)).toBe(10);
  });

  it("returns fallback for empty string", () => {
    expect(parseIntOr("", 10)).toBe(10);
  });

  it("returns fallback for NaN input", () => {
    expect(parseIntOr("abc", 10)).toBe(10);
  });

  it("returns fallback for negative numbers", () => {
    expect(parseIntOr("-5", 10)).toBe(10);
  });

  it("returns fallback for zero", () => {
    expect(parseIntOr("0", 10)).toBe(10);
  });

  it("returns parsed value for valid positive integer", () => {
    expect(parseIntOr("42", 10)).toBe(42);
  });

  it("uses the provided fallback value", () => {
    expect(parseIntOr(undefined, 99)).toBe(99);
  });

  it("truncates float strings via parseInt", () => {
    expect(parseIntOr("3.9", 10)).toBe(3);
  });
});

describe("parseFloatOr", () => {
  it("returns fallback for undefined", () => {
    expect(parseFloatOr(undefined, 0.5)).toBe(0.5);
  });

  it("returns fallback for empty string", () => {
    expect(parseFloatOr("", 0.5)).toBe(0.5);
  });

  it("returns fallback for NaN input", () => {
    expect(parseFloatOr("abc", 0.5)).toBe(0.5);
  });

  it("returns fallback for negative values", () => {
    expect(parseFloatOr("-0.5", 0.5)).toBe(0.5);
  });

  it("accepts zero as valid", () => {
    expect(parseFloatOr("0", 0.5)).toBe(0);
  });

  it("returns parsed value for valid float", () => {
    expect(parseFloatOr("3.14", 0.5)).toBeCloseTo(3.14);
  });

  it("uses the provided fallback value", () => {
    expect(parseFloatOr(undefined, 1.5)).toBe(1.5);
  });
});

describe("parsePositiveIntOrUndefined", () => {
  it("returns undefined for undefined input", () => {
    expect(parsePositiveIntOrUndefined(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parsePositiveIntOrUndefined("")).toBeUndefined();
  });

  it("returns undefined for NaN input", () => {
    expect(parsePositiveIntOrUndefined("abc")).toBeUndefined();
  });

  it("returns undefined for negative numbers", () => {
    expect(parsePositiveIntOrUndefined("-5")).toBeUndefined();
  });

  it("returns undefined for zero", () => {
    expect(parsePositiveIntOrUndefined("0")).toBeUndefined();
  });

  it("returns parsed value for valid positive integer", () => {
    expect(parsePositiveIntOrUndefined("42")).toBe(42);
  });

  it("returns parsed value for string '1'", () => {
    expect(parsePositiveIntOrUndefined("1")).toBe(1);
  });
});
