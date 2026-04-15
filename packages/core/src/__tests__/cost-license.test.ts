import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
import { isFeatureLicensed } from "../license.js";
import * as core from "../index.js";

describe("cost-roi license flag + core barrel re-export", () => {
  afterEach(async () => {
    await restoreLicense();
  });

  it("is gated off under pro tier", async () => {
    await installTestProLicense("pro");
    expect(isFeatureLicensed("cost-roi")).toBe(false);
  });

  it("is enabled under enterprise tier", async () => {
    await installTestProLicense("enterprise");
    expect(isFeatureLicensed("cost-roi")).toBe(true);
  });

  it("re-exports cost helpers from @urateam/core barrel", () => {
    expect(typeof (core as Record<string, unknown>).computeRunCost).toBe("function");
    expect(typeof (core as Record<string, unknown>).aggregateAll).toBe("function");
    expect(typeof (core as Record<string, unknown>).resolveModelRate).toBe("function");
  });
});
