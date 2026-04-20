import { describe, expect, it } from "vitest";
import { createPublicKey } from "node:crypto";
import { LICENSE_PUBLIC_KEY_DER_B64 } from "../license-public-key.js";

describe("embedded production public key", () => {
  it("is a structurally valid Ed25519 SPKI-DER base64 string", () => {
    const buf = Buffer.from(LICENSE_PUBLIC_KEY_DER_B64, "base64");
    // Ed25519 SPKI: 12-byte ASN.1 prefix + 32-byte raw public key = 44 bytes.
    // A character transposition or truncation in the constant would typically
    // still be "parseable" as some key; the length + OID check catches
    // specifically-bad tweaks the createPublicKey round-trip alone misses.
    expect(buf.byteLength).toBe(44);
    // OID for Ed25519 is 1.3.101.112, encoded as hex `2b6570` at bytes 6-8.
    expect(buf.subarray(6, 9).toString("hex")).toBe("2b6570");
    const key = createPublicKey({ key: buf, format: "der", type: "spki" });
    expect(key.asymmetricKeyType).toBe("ed25519");
  });
});
