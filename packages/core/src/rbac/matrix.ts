import type { Role } from "./types.js";
import { isFeatureLicensed } from "../license.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "rbac" });

export const PERMISSION_MATRIX = {
  "runs.view":         ["admin", "operator", "viewer"],
  "runs.retry":        ["admin", "operator"],
  "tokens.view":       ["admin", "operator", "viewer"],
  "audit.view":        ["admin", "operator"],
  "audit.export":      ["admin", "operator"],
  "cost.view":         ["admin", "operator"],
  "cost.export":       ["admin", "operator"],
  "errors.view":       ["admin", "operator", "viewer"],
  "coordination.view": ["admin", "operator"],
  "config.view":       ["admin"],
  "users.view":        ["admin"],
  "users.manage":      ["admin"],
} as const satisfies Record<string, readonly Role[]>;

export type PermissionKey = keyof typeof PERMISSION_MATRIX;

/**
 * Check whether `role` is allowed to perform `action`.
 *
 * Defensive license gate: returns `false` (fail closed, "no permission") with
 * a structured warn when the `rbac` feature is not licensed. The gate is
 * additive to — not a replacement for — the upstream guards in the dashboard
 * middleware and the runs UI, both of which already skip calling `canAccess`
 * in OSS mode. Its purpose is to ensure any future direct caller of the rbac
 * module — a new route, CLI command, third-party integration — cannot
 * silently grant permissions without a license check.
 *
 * Returns `false` rather than throwing because callers (e.g., the canRetry
 * ternary in `dashboard/src/routes/runs.ts`) treat the result as a predicate.
 * Initializers that cannot tolerate a silent denial should mirror the
 * `getDefaultWorkosClient` pattern in `auth/workos-client.ts` (throws
 * `LicenseRequiredError`).
 */
export function canAccess(role: Role, action: PermissionKey): boolean {
  if (!isFeatureLicensed("rbac")) {
    log.warn(
      { feature: "rbac", action, role },
      "canAccess called without an enterprise license — denying (fail closed)",
    );
    return false;
  }
  return (PERMISSION_MATRIX[action] as readonly Role[]).includes(role);
}
