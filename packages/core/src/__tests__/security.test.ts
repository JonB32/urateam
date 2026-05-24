import { describe, it, expect } from "vitest";
import {
  SECURITY_REVIEW_CHECKLIST,
  REVIEW_OUTPUT_FORMAT,
} from "../security/review-checklist.js";

describe("SECURITY_REVIEW_CHECKLIST", () => {
  it("contains INJECTION VULNERABILITIES category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain("INJECTION VULNERABILITIES");
  });

  it("contains AUTHENTICATION & AUTHORIZATION category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain(
      "AUTHENTICATION & AUTHORIZATION",
    );
  });

  it("contains DATA EXPOSURE category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain("DATA EXPOSURE");
  });

  it("contains DEPENDENCY SAFETY category", () => {
    expect(SECURITY_REVIEW_CHECKLIST).toContain("DEPENDENCY SAFETY");
  });

  it("REVIEW_OUTPUT_FORMAT describes JSON output", () => {
    expect(REVIEW_OUTPUT_FORMAT).toContain("JSON");
    expect(REVIEW_OUTPUT_FORMAT).toContain("severity");
  });
});

