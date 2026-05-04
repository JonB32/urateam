import { describe, it, expect } from "vitest";
import { ReleaseManagerConfigSchema } from "../release-manager/types.js";

describe("ReleaseManagerConfigSchema", () => {
  it("parses a minimal valid config (one trigger set)", () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5 },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.versionBump).toBe("patch");
    expect(cfg.branch).toBe("main");
    expect(cfg.schedule).toBe("*/30 * * * *");
    expect(cfg.triggers.mergedPRsSince).toBe(5);
  });

  it("throws when no trigger field is set", () => {
    expect(() =>
      ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: {},
      })
    ).toThrow(/at least one trigger/i);
  });

  it("throws when requireSlackApproval=true but slackChannel is unset", () => {
    expect(() =>
      ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: { mergedPRsSince: 5, requireSlackApproval: true },
      })
    ).toThrow(/slackChannel/i);
  });

  it("accepts requireSlackApproval=true with slackChannel", () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5, requireSlackApproval: true },
      slackChannel: "#releases",
    });
    expect(cfg.triggers.requireSlackApproval).toBe(true);
    expect(cfg.slackChannel).toBe("#releases");
  });

  it("accepts versionBump enum values", () => {
    expect(ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5 },
      versionBump: "minor",
    }).versionBump).toBe("minor");
    expect(ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: { mergedPRsSince: 5 },
      versionBump: "conventional-commits",
    }).versionBump).toBe("conventional-commits");
  });

  it("rejects invalid versionBump values (e.g. 'major')", () => {
    expect(() =>
      ReleaseManagerConfigSchema.parse({
        enabled: true,
        triggers: { mergedPRsSince: 5 },
        versionBump: "major",
      })
    ).toThrow();
  });
});
