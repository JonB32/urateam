/**
 * Embedded Ed25519 public key for verifying urateam license JWTs.
 *
 * Format: SubjectPublicKeyInfo (SPKI) DER, base64-encoded.
 *
 * The corresponding private key (`SIGNING_KEY` Workers Secret) lives on the
 * `urateam-licensing` service at `billing.urateams.com`. It is never committed
 * to this repo. See `urateam-licensing/docs/rotation.md` for the dual-key
 * handoff procedure required when rotating (old + new keys must verify side-
 * by-side for 13 months so outstanding customer JWTs don't fail validation
 * mid-lifetime).
 */
export const LICENSE_PUBLIC_KEY_DER_B64 =
  "MCowBQYDK2VwAyEAgEyvXLTYbpAZriMQVZDuhXnkdDeUiuDiX0Y9+ZFvix4=";
