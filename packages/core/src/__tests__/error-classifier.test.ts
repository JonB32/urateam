import { describe, it, expect } from "vitest";
import { isTransientError } from "../pipeline/error-classifier.js";

describe("isTransientError", () => {
  it.each([
    ["401 authentication_error"],
    ["Invalid authentication credentials"],
    ["Failed to authenticate. API Error: 401"],
    ["429 Too Many Requests"],
    ["rate limit exceeded"],
    ["Claude API rate limit exceeded"],
    ["ECONNRESET"],
    ["ETIMEDOUT"],
    ["ECONNREFUSED"],
    ["socket hang up"],
    ["network timeout"],
    ["fetch failed"],
    ["git push failed: fatal: unable to access"],
  ])("classifies '%s' as transient", (msg) => {
    expect(isTransientError(msg)).toBe(true);
  });

  it.each([
    ["Test failed: 3 of 10 tests failed"],
    ["Build failed with exit code 1"],
    ["TypeError: Cannot read properties of undefined"],
    ["Handoff validation failed"],
    ["No files changed"],
    ["Stage implement failed after 2 attempts"],
    ["some random error"],
  ])("classifies '%s' as permanent", (msg) => {
    expect(isTransientError(msg)).toBe(false);
  });
});
