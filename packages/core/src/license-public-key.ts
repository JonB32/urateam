/**
 * Embedded Ed25519 public key for verifying urateam license JWTs.
 *
 * Format: SubjectPublicKeyInfo (SPKI) DER, base64-encoded.
 *
 * The corresponding private key (`SIGNING_KEY` Workers Secret) lives on the
 * `urateam-licensing` service at `billing.urateams.com`. It is never committed
 * to this repo. See `urateam-licensing/docs/rotation.md` for the dual-key
 * handoff procedure required when rotating: old + new keys must verify side-
 * by-side for ≥ 390 days (the JWT lifetime constant, 13 × 30 days, NOT 13
 * calendar months — the constant is ~5.7 days short of a calendar year-plus-
 * one-month). This way no outstanding customer JWT is rejected mid-lifetime.
 */
export const LICENSE_PUBLIC_KEY_DER_B64 =
  "MCowBQYDK2VwAyEAgEyvXLTYbpAZriMQVZDuhXnkdDeUiuDiX0Y9+ZFvix4=";
