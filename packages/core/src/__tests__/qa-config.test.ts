import { describe, it, expect } from "vitest";
import { QaCheckConfigSchema } from "../qa/types.js";
import { ReleaseManagerConfigSchema } from "../release-manager/types.js";

describe("QaCheckConfigSchema", () => {
  it("parses minimal valid config", () => {
    const cfg = QaCheckConfigSchema.parse({
      workflow: ".github/workflows/smoke.yml",
      linearTeamId: "team-uuid-123",
    });
    expect(cfg.workflow).toBe(".github/workflows/smoke.yml");
    expect(cfg.timeoutMinutes).toBe(30); // default
    expect(cfg.linearTeamId).toBe("team-uuid-123");
    expect(cfg.workflowInputs).toBeUndefined();
  });

  it("respects custom timeoutMinutes", () => {
    const cfg = QaCheckConfigSchema.parse({
      workflow: ".github/workflows/smoke.yml",
      linearTeamId: "team-uuid-123",
      timeoutMinutes: 60,
    });
    expect(cfg.timeoutMinutes).toBe(60);
  });

  it("accepts workflowInputs object", () => {
    const cfg = QaCheckConfigSchema.parse({
      workflow: ".github/workflows/smoke.yml",
      linearTeamId: "team-uuid-123",
      workflowInputs: { environment: "preview" },
    });
    expect(cfg.workflowInputs).toEqual({ environment: "preview" });
  });

  it("rejects empty workflow string", () => {
    expect(() =>
      QaCheckConfigSchema.parse({
        workflow: "",
        linearTeamId: "team-uuid-123",
      })
    ).toThrow();
  });

  it("rejects empty linearTeamId", () => {
    expect(() =>
      QaCheckConfigSchema.parse({
        workflow: ".github/workflows/smoke.yml",
        linearTeamId: "",
      })
    ).toThrow();
  });

  it("rejects non-positive timeoutMinutes", () => {
    expect(() =>
      QaCheckConfigSchema.parse({
        workflow: ".github/workflows/smoke.yml",
        linearTeamId: "team-uuid-123",
        timeoutMinutes: 0,
      })
    ).toThrow();
  });
});

describe("ReleaseManagerConfigSchema with qaCheck", () => {
  it("accepts a qaCheck trigger alongside existing triggers", () => {
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: {
        mergedPRsSince: 5,
        qaCheck: {
          workflow: ".github/workflows/smoke.yml",
          linearTeamId: "team-uuid-123",
        },
      },
    });
    expect(cfg.triggers.qaCheck?.workflow).toBe(".github/workflows/smoke.yml");
    expect(cfg.triggers.qaCheck?.timeoutMinutes).toBe(30);
  });

  it("treats qaCheck as a valid trigger to satisfy 'at least one trigger' guard", () => {
    // qaCheck alone (no mergedPRsSince/timeSinceLastHours/ciGreenForMinutes/requireSlackApproval) should pass
    const cfg = ReleaseManagerConfigSchema.parse({
      enabled: true,
      triggers: {
        qaCheck: {
          workflow: ".github/workflows/smoke.yml",
          linearTeamId: "team-uuid-123",
        },
      },
    });
    expect(cfg.triggers.qaCheck).toBeDefined();
  });
});
