import { createLogger } from "./logger.js";

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
const ALL_COMMERCIAL_FEATURES = new Set<string>(ENTERPRISE_FEATURES);

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
 * JWT validation is added in Task 4 of the license-infrastructure-phase-0
 * plan; for now, presence of the env var is ignored on the OSS path.
 */
export function checkLicense(): LicenseStatus {
  if (cachedStatus) return cachedStatus;

  const key = process.env.URATEAM_LICENSE_KEY;
  if (!key) {
    cachedStatus = ossStatus();
    log.info({ tier: "oss" }, "no license key set — running in OSS mode");
    return cachedStatus;
  }

  // Placeholder for Task 4: real JWT validation lives here.
  cachedStatus = ossStatus("malformed");
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

/** Reset cached status (for tests). */
export function _resetLicenseCache(): void {
  cachedStatus = null;
}
