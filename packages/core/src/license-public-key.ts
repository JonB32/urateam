/**
 * Embedded Ed25519 public key for verifying urateam license JWTs.
 *
 * Format: SubjectPublicKeyInfo (SPKI) DER, base64-encoded.
 *
 * The corresponding private key is held by the operator and never enters
 * the repository. To rotate the key:
 *   1. Run `pnpm tsx scripts/generate-license-keypair.ts`
 *   2. Replace this constant with the new public key
 *   3. Re-issue all outstanding licenses with the new private key
 *   4. Cut a urateam release; old licenses fail validation after upgrade
 */
export const LICENSE_PUBLIC_KEY_DER_B64 =
  "MCowBQYDK2VwAyEAfdqBhcSi6VOkQ6LnYBSAH1Jq3gAwIhQ8YOiPOYIzhxc=";
