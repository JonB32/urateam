import { describe, it, expect } from "vitest";
import { signState, verifyState, newNonce } from "../lib/oauth-state.js";

describe("OAuth state HMAC", () => {
  it("round-trips a nonce", () => {
    const secret = "fixed-secret-for-test";
    const signed = signState(secret, "nonce-abc");
    expect(verifyState(secret, signed)).toBe("nonce-abc");
  });

  it("rejects a tampered nonce", () => {
    const secret = "fixed-secret-for-test";
    const signed = signState(secret, "nonce-abc");
    const [nonce, sig] = signed.split(".");
    const tampered = `${nonce}-tampered.${sig}`;
    expect(verifyState(secret, tampered)).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const signed = signState("secret-a", "nonce-abc");
    expect(verifyState("secret-b", signed)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState("any-secret", "")).toBeNull();
    expect(verifyState("any-secret", "no-dot")).toBeNull();
    expect(verifyState("any-secret", "too.many.dots")).toBeNull();
  });

  it("rejects same-length-but-wrong sig without throwing", () => {
    const signed = signState("secret", "nonce");
    const [nonce] = signed.split(".");
    const wrongButSameLen = `${nonce}.${"f".repeat(64)}`;
    expect(() => verifyState("secret", wrongButSameLen)).not.toThrow();
    expect(verifyState("secret", wrongButSameLen)).toBeNull();
  });

  it("newNonce produces unique 32-char hex values", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
