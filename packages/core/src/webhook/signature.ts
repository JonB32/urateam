import { createHmac, timingSafeEqual } from "crypto";

export function verifyLinearSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  const expected = hmac.digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // Different lengths
  }
}
