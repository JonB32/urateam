import { describe, it, expect } from "vitest";
import { parseJsonOr } from "../util/json.js";

describe("parseJsonOr", () => {
  it("returns fallback for null", () => {
    expect(parseJsonOr(null, [])).toEqual([]);
  });

  it("returns fallback for undefined", () => {
    expect(parseJsonOr(undefined, [])).toEqual([]);
  });

  it("returns fallback for invalid JSON", () => {
    expect(parseJsonOr("not json", [])).toEqual([]);
  });

  it("returns fallback for empty string", () => {
    expect(parseJsonOr("", null)).toBeNull();
  });

  it("returns parsed object for valid JSON", () => {
    expect(parseJsonOr('{"a": 1}', null)).toEqual({ a: 1 });
  });

  it("returns parsed array for valid JSON array", () => {
    expect(parseJsonOr('[1, 2, 3]', null)).toEqual([1, 2, 3]);
  });

  it("preserves generic type in the return value", () => {
    const result = parseJsonOr<{ count: number }>('{"count": 5}', { count: 0 });
    expect(result.count).toBe(5);
  });

  it("returns fallback value when JSON is malformed", () => {
    expect(parseJsonOr("{bad json", { default: true })).toEqual({ default: true });
  });

  it("returns fallback for truncated JSON", () => {
    expect(parseJsonOr('{"a":', null)).toBeNull();
  });
});
