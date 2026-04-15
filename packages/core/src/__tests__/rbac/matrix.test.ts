import { describe, it, expect } from "vitest";
import { canAccess, PERMISSION_MATRIX } from "../../rbac/matrix.js";
import type { PermissionKey } from "../../rbac/matrix.js";

describe("PERMISSION_MATRIX", () => {
  const cases: Array<[PermissionKey, "admin" | "operator" | "viewer", boolean]> = [
    ["runs.view",         "admin",    true],
    ["runs.view",         "operator", true],
    ["runs.view",         "viewer",   true],
    ["runs.retry",        "admin",    true],
    ["runs.retry",        "operator", true],
    ["runs.retry",        "viewer",   false],
    ["tokens.view",       "admin",    true],
    ["tokens.view",       "operator", true],
    ["tokens.view",       "viewer",   true],
    ["audit.view",        "admin",    true],
    ["audit.view",        "operator", true],
    ["audit.view",        "viewer",   false],
    ["audit.export",      "viewer",   false],
    ["cost.view",         "admin",    true],
    ["cost.view",         "viewer",   false],
    ["cost.export",       "admin",    true],
    ["cost.export",       "viewer",   false],
    ["errors.view",       "viewer",   true],
    ["coordination.view", "operator", true],
    ["coordination.view", "viewer",   false],
    ["config.view",       "admin",    true],
    ["config.view",       "operator", false],
    ["config.view",       "viewer",   false],
    ["users.view",        "admin",    true],
    ["users.view",        "operator", false],
    ["users.view",        "viewer",   false],
    ["users.manage",      "admin",    true],
    ["users.manage",      "operator", false],
  ];

  it.each(cases)("canAccess(%s, %s) === %s", (action, role, expected) => {
    expect(canAccess(role, action)).toBe(expected);
  });

  it("admin has at least as many permissions as operator", () => {
    const keys = Object.keys(PERMISSION_MATRIX) as PermissionKey[];
    for (const k of keys) {
      if (canAccess("operator", k)) expect(canAccess("admin", k)).toBe(true);
    }
  });

  it("operator has at least as many permissions as viewer", () => {
    const keys = Object.keys(PERMISSION_MATRIX) as PermissionKey[];
    for (const k of keys) {
      if (canAccess("viewer", k)) expect(canAccess("operator", k)).toBe(true);
    }
  });
});
