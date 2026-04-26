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
 * a structured warn when the `rbac` feature is not licensed. Today the
 * dashboard middleware (`packages/dashboard/src/middleware/rbac.ts:12`) and
 * the runs UI (`packages/dashboard/src/routes/runs.ts:130`) both short-circuit
 * before calling `canAccess` in OSS mode, so this gate does not change
 * production behavior. It exists so that any future direct caller of the rbac
 * module — a new route, CLI command, third-party integration — cannot silently
 * grant permissions without a license check.
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
