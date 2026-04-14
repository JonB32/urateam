import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageVersion } from "../version.js";

describe("getPackageVersion", () => {
  it("returns the version from package.json", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(getPackageVersion()).toBe(pkg.version);
  });

  it("returns a semver-shaped string", () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
