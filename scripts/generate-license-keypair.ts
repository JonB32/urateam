#!/usr/bin/env tsx
/**
 * Generate a fresh Ed25519 keypair for license signing.
 *
 * Usage:
 *   pnpm tsx scripts/generate-license-keypair.ts
 *
 * This script is ONLY for local dev / `ura license issue` offline use.
 * The production license signing key lives in the `urateam-licensing`
 * Worker at `billing.urateams.com` — see that repo's
 * `worker/scripts/gen-signing-key.ts` + `docs/rotation.md`. The public
 * key at packages/core/src/license-public-key.ts is the published-
 * product key and should NOT be updated from this script's output
 * except via the documented rotation procedure.
 *
 * Prints the public key and the private key (store securely — DO NOT
 * commit). The private key is needed by `ura license issue` for
 * offline Enterprise license minting.
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const publicRaw = publicKey.export({ format: "der", type: "spki" });
const privateRaw = privateKey.export({ format: "der", type: "pkcs8" });

const publicB64 = Buffer.from(publicRaw).toString("base64");
const privateB64 = Buffer.from(privateRaw).toString("base64");

console.log("# Public key (paste into packages/core/src/license-public-key.ts)");
console.log(`URATEAM_LICENSE_PUBLIC_KEY_DER_B64="${publicB64}"`);
console.log("");
console.log("# Private key (STORE SECURELY — operator-only, never commit)");
console.log(`URATEAM_LICENSE_SIGNING_KEY="${privateB64}"`);
