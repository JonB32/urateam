/**
 * HMAC-signed OAuth `state` parameter helpers.
 *
 * The OAuth provider echoes `state` back on the callback; verifying the HMAC
 * before trusting the callback's `code` defends against open-redirect / CSRF
 * attacks. Format: `<nonce>.<hmac-sha256-hex>`. The secret is per-invocation
 * and never persisted — sign + verify happen in the same process.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function signState(secret: string, nonce: string): string {
  const sig = createHmac("sha256", secret).update(nonce).digest("hex");
  return `${nonce}.${sig}`;
}

/**
 * Returns the verified nonce when `state` is valid; `null` otherwise.
 * Constant-time signature comparison so attacker timing observations don't
 * leak the expected signature byte-by-byte.
 */
export function verifyState(secret: string, state: string): string | null {
  if (!state) return null;
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [nonce, providedSig] = parts;
  if (!nonce || !providedSig) return null;
  const expectedSig = createHmac("sha256", secret).update(nonce).digest("hex");
  const a = Buffer.from(providedSig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length) return null;
  try {
    return timingSafeEqual(a, b) ? nonce : null;
  } catch {
    return null;
  }
}
