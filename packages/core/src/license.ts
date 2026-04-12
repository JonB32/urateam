import { createLogger } from "./logger.js";

const log = createLogger({ component: "license" });

export interface LicenseStatus {
  licensed: boolean;
  tier: "free" | "pro" | "team" | "enterprise";
  key?: string;
}

const COMMERCIAL_FEATURES = new Set([
  "slack-interface",
  "conflict-detection",
  "deep-review",
  "approval-workflows",
  "multi-repo",
  "stage-models",
  "advanced-automerge",
]);

let cachedStatus: LicenseStatus | null = null;

/**
 * Check the license status from URATEAM_LICENSE_KEY env var.
 * Result is cached for the lifetime of the process.
 */
export function checkLicense(): LicenseStatus {
  if (cachedStatus) return cachedStatus;

  const key = process.env.URATEAM_LICENSE_KEY;
  if (!key) {
    cachedStatus = { licensed: false, tier: "free" };
    return cachedStatus;
  }

  // For now, any non-empty key grants "pro" tier.
  // Future: validate JWT signature, extract tier from claims.
  cachedStatus = { licensed: true, tier: "pro", key };
  log.info({ tier: "pro" }, "license key validated");
  return cachedStatus;
}

/**
 * Check if a specific feature is available under the current license.
 * Returns true for free features regardless of license status.
 */
export function isFeatureLicensed(feature: string): boolean {
  if (!COMMERCIAL_FEATURES.has(feature)) return true;
  return checkLicense().licensed;
}

/** Reset cached status (for testing). */
export function _resetLicenseCache(): void {
  cachedStatus = null;
}
