import { createPublicKey, verify } from "node:crypto";
import { createLogger } from "./logger.js";
import * as publicKeyMod from "./license-public-key.js";
import type { AnyDb } from "./db/client.js";
import { logAuditEventUnchecked } from "./audit/writer.js";
import { licenseValidationFailedEvent } from "./audit/events.js";

const log = createLogger({ component: "license" });

export type Tier = "oss" | "pro" | "enterprise";

export interface LicenseStatus {
  licensed: boolean;
  tier: Tier;
  customerId?: string;
  expiresAt?: Date;
  seats?: number | null;
  features: Set<string>;
  invalidReason?: "missing" | "expired" | "bad-signature" | "wrong-issuer" | "malformed";
}

/**
 * Features each tier unlocks. Higher tiers inherit lower-tier features.
 * Source of truth: docs/superpowers/specs/2026-04-13-enterprise-tier-design.md § 3.
 */
const PRO_FEATURES = [
  "slack-interface",
  "conflict-detection",
  "deep-review",
  "approval-workflows",
  "multi-repo",
  "stage-models",
  "advanced-automerge",
];

const ENTERPRISE_FEATURES = [
  ...PRO_FEATURES,
  "sso",
  "audit-log",
  "spend-caps",
  "rbac",
  "cost-dashboard",
  "cost-roi",
  "org-policy",
  "pm-agent-governance",
];

const FEATURES_BY_TIER: Record<Tier, ReadonlySet<string>> = {
  oss: new Set(),
  pro: new Set(PRO_FEATURES),
  enterprise: new Set(ENTERPRISE_FEATURES),
};

/**
 * The complete set of features that are commercially gated. A feature
 * not in this set is always available regardless of license status.
 */
const ALL_COMMERCIAL_FEATURES = new Set<string>(
  Object.values(FEATURES_BY_TIER).flatMap((s) => [...s]),
);

let cachedStatus: LicenseStatus | null = null;

function ossStatus(invalidReason?: LicenseStatus["invalidReason"]): LicenseStatus {
  return {
    licensed: false,
    tier: "oss",
    features: new Set(FEATURES_BY_TIER.oss),
    invalidReason,
  };
}

/**
 * Check the license status from URATEAM_LICENSE_KEY env var.
 * Result is cached for the lifetime of the process.
 *
 * Pass `db` to emit a `license.validation_failed` audit event on the failure
 * path. Only the first call with a db argument will emit (thanks to caching).
 */
export function checkLicense(db?: AnyDb): LicenseStatus {
  if (cachedStatus) return cachedStatus;

  const key = process.env.URATEAM_LICENSE_KEY;
  if (!key) {
    cachedStatus = ossStatus();
    log.info({ tier: "oss" }, "no license key set — running in OSS mode");
    return cachedStatus;
  }

  const result = verifyJwt(key);
  if (!result.ok) {
    cachedStatus = ossStatus(result.reason);
    log.warn({ reason: result.reason }, "license key invalid — running in OSS mode");
    if (db && result.reason !== "malformed") {
      void logAuditEventUnchecked(
        db,
        licenseValidationFailedEvent({ invalidReason: result.reason }),
      );
    }
    return cachedStatus;
  }

  const claims = result.claims;
  const explicitFeatures = Array.isArray(claims.features) ? new Set(claims.features) : null;
  const features = explicitFeatures ?? new Set(FEATURES_BY_TIER[claims.tier]);

  cachedStatus = {
    licensed: true,
    tier: claims.tier,
    customerId: claims.sub,
    expiresAt: new Date(claims.exp * 1000),
    seats: claims.seats ?? null,
    features,
  };
  log.info(
    {
      tier: claims.tier,
      customerId: claims.sub,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    },
    "license key validated",
  );
  return cachedStatus;
}

/**
 * Check if a specific feature is available under the current license.
 * Returns true for non-commercial features regardless of license status.
 */
export function isFeatureLicensed(feature: string): boolean {
  if (!ALL_COMMERCIAL_FEATURES.has(feature)) return true;
  return checkLicense().features.has(feature);
}

/**
 * Thrown when a commercially gated feature is invoked without a license that
 * unlocks it. Library entry points for gated features (SSO, RBAC, cost
 * calculation, etc.) throw this when callers can't be served a safe default
 * — the caller MUST hold a valid license to proceed.
 */
export class LicenseRequiredError extends Error {
  readonly feature: string;
  constructor(feature: string) {
    super(
      `feature "${feature}" requires a license that unlocks it; running in OSS mode`,
    );
    this.name = "LicenseRequiredError";
    this.feature = feature;
  }
}

interface JwtClaims {
  iss: string;
  sub: string;
  tier: Tier;
  seats: number | null | undefined;
  iat: number;
  exp: number;
  features?: string[];
}

type VerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: NonNullable<LicenseStatus["invalidReason"]> };

const ISSUER = "urateams.com";

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function verifyJwt(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [headerB64, payloadB64, sigB64] = parts;

  let claims: JwtClaims;
  try {
    const header = JSON.parse(b64urlDecode(headerB64).toString("utf-8"));
    if (header.alg !== "EdDSA") return { ok: false, reason: "malformed" };
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(publicKeyMod.LICENSE_PUBLIC_KEY_DER_B64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlDecode(sigB64);
  const valid = verify(null, signingInput, publicKey, signature);
  if (!valid) return { ok: false, reason: "bad-signature" };

  if (claims.iss !== ISSUER) return { ok: false, reason: "wrong-issuer" };

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    return { ok: false, reason: "expired" };
  }

  if (claims.tier !== "oss" && claims.tier !== "pro" && claims.tier !== "enterprise") {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, claims };
}

/** Reset cached status (for tests). */
export function _resetLicenseCache(): void {
  cachedStatus = null;
}
