import { describe, it, expect, afterEach } from "vitest";
import { _resetLicenseCache } from "../license.js";
import { canAccess } from "../rbac/matrix.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";

afterEach(async () => {
  _resetLicenseCache();
  await restoreLicense();
});

describe("canAccess defensive license gate", () => {
  it("returns false in OSS mode regardless of role + action", () => {
    expect(canAccess("admin", "users.manage")).toBe(false);
    expect(canAccess("admin", "runs.view")).toBe(false);
    expect(canAccess("operator", "runs.view")).toBe(false);
    expect(canAccess("viewer", "runs.view")).toBe(false);
  });

  it("returns false at pro tier (rbac is enterprise-only)", async () => {
    await installTestProLicense("pro");
    expect(canAccess("admin", "users.manage")).toBe(false);
    expect(canAccess("admin", "runs.view")).toBe(false);
  });

  it("falls through to the matrix at enterprise tier", async () => {
    await installTestProLicense("enterprise");
    // Sanity-check the matrix still drives the result post-gate.
    expect(canAccess("admin", "users.manage")).toBe(true);
    expect(canAccess("operator", "users.manage")).toBe(false);
    expect(canAccess("viewer", "runs.view")).toBe(true);
    expect(canAccess("viewer", "runs.retry")).toBe(false);
  });
});
