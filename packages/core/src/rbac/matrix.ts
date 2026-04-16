import type { Role } from "./types.js";

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

export function canAccess(role: Role, action: PermissionKey): boolean {
  return (PERMISSION_MATRIX[action] as readonly Role[]).includes(role);
}
