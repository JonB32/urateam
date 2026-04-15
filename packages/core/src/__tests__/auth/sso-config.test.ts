import { describe, it, expect } from "vitest";
import { SsoConfigSchema } from "../../types.js";
import { signState, verifyState, validateNextPath } from "../../auth/sso-config.js";

const validConfig = {
  enabled: true,
  workosApiKey: "sk_test_xxx",
  workosClientId: "client_xxx",
  redirectUri: "https://example.com/auth/callback",
  stateSigningSecret: "0123456789abcdef0123456789abcdef",
};

describe("SsoConfigSchema", () => {
  it("parses a valid config", () => {
    const parsed = SsoConfigSchema.parse(validConfig);
    expect(parsed.sessionDurationHours).toBe(24);
    expect(parsed.cookieName).toBe("urateam_session");
    expect(parsed.cookieSecure).toBe(true);
  });

  it("rejects missing apiKey", () => {
    const bad = { ...validConfig } as any;
    delete bad.workosApiKey;
    expect(() => SsoConfigSchema.parse(bad)).toThrow();
  });

  it("rejects non-url redirectUri", () => {
    expect(() => SsoConfigSchema.parse({ ...validConfig, redirectUri: "not-a-url" })).toThrow();
  });
});

describe("signState / verifyState", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  it("round-trips a payload", () => {
    const signed = signState({ next: "/runs", nonce: "abc" }, secret);
    const verified = verifyState(signed, secret);
    expect(verified).toEqual({ next: "/runs", nonce: "abc" });
  });

  it("rejects a tampered payload", () => {
    const signed = signState({ next: "/runs", nonce: "abc" }, secret);
    // Flip the first char of the payload portion to simulate tampering.
    // (Plan's original `.replace("/runs", "/evil")` is a no-op because the
    // payload is base64url-encoded and contains no "/runs" substring.)
    const tampered = (signed[0] === "a" ? "b" : "a") + signed.slice(1);
    expect(verifyState(tampered, secret)).toBeNull();
  });

  it("rejects a wrong-secret signature", () => {
    const signed = signState({ next: "/runs", nonce: "abc" }, secret);
    expect(verifyState(signed, "different-secret-1234567890abcdef")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState("garbage", secret)).toBeNull();
    expect(verifyState("no.dot", secret)).toBeNull();
    expect(verifyState("", secret)).toBeNull();
  });
});

describe("validateNextPath", () => {
  it("accepts same-origin absolute paths", () => {
    expect(validateNextPath("/")).toBe("/");
    expect(validateNextPath("/runs")).toBe("/runs");
    expect(validateNextPath("/runs/123")).toBe("/runs/123");
  });

  it("rejects scheme-relative URLs", () => {
    expect(validateNextPath("//evil.com")).toBe("/");
    expect(validateNextPath("//evil.com/path")).toBe("/");
  });

  it("rejects absolute URLs", () => {
    expect(validateNextPath("https://evil.com")).toBe("/");
    expect(validateNextPath("http://evil.com")).toBe("/");
  });

  it("rejects backslash variants", () => {
    expect(validateNextPath("/\\evil.com")).toBe("/");
    expect(validateNextPath("\\\\evil.com")).toBe("/");
  });

  it("falls back to / for empty / nullish", () => {
    expect(validateNextPath("")).toBe("/");
    expect(validateNextPath(undefined as any)).toBe("/");
  });
});
