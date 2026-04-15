import { createHmac, timingSafeEqual } from "node:crypto";

interface StatePayload {
  next: string;
  nonce: string;
}

export function signState(payload: StatePayload, secret: string): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, "utf8").toString("base64url");
  const hmac = createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${hmac}`;
}

export function verifyState(signed: string, secret: string): StatePayload | null {
  if (!signed || typeof signed !== "string") return null;
  const idx = signed.lastIndexOf(".");
  if (idx <= 0 || idx === signed.length - 1) return null;
  const b64 = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = createHmac("sha256", secret).update(b64).digest("base64url");
  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const json = Buffer.from(b64, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    if (typeof parsed?.next !== "string" || typeof parsed?.nonce !== "string") return null;
    return parsed as StatePayload;
  } catch {
    return null;
  }
}

/**
 * Validate that `next` is a same-origin absolute path. Reject scheme-relative
 * (`//evil.com`), absolute (`https://evil.com`), and backslash variants.
 * Falls back to "/" on any rejection.
 */
export function validateNextPath(next: string | undefined | null): string {
  if (!next || typeof next !== "string") return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  if (next.startsWith("/\\") || next.includes("\\")) return "/";
  return next;
}
