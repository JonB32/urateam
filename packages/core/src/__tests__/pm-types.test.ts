import { describe, it, expect, expectTypeOf } from "vitest";
import { PmAgentConfigSchema, type PmAgentConfig } from "../pm/types.js";

describe("PmAgentConfigSchema", () => {
  it("validates a complete valid config", () => {
    const config = {
      enabled: true,
      cronIntervalMs: 1800000,
      maxInFlight: 3,
      dailyTokenBudget: 5000000,
      slackChannelId: "C0123456789",
      teamIds: ["team-abc", "team-def"],
    };
    const result = PmAgentConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("applies defaults for optional fields", () => {
    const config = {
      enabled: true,
      dailyTokenBudget: 5000000,
      slackChannelId: "C0123456789",
      teamIds: ["team-abc"],
    };
    const result = PmAgentConfigSchema.parse(config);
    expect(result.cronIntervalMs).toBe(1800000);
    expect(result.maxInFlight).toBe(3);
    expect(result.triageBatchSize).toBe(3);
  });

  it("accepts custom triageBatchSize", () => {
    const config = {
      enabled: true,
      dailyTokenBudget: 5000000,
      slackChannelId: "C0123456789",
      teamIds: ["team-abc"],
      triageBatchSize: 5,
    };
    const result = PmAgentConfigSchema.parse(config);
    expect(result.triageBatchSize).toBe(5);
  });

  it("rejects triageBatchSize < 1", () => {
    const config = {
      enabled: true,
      dailyTokenBudget: 5000000,
      slackChannelId: "C0123456789",
      teamIds: ["team-abc"],
      triageBatchSize: 0,
    };
    const result = PmAgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = PmAgentConfigSchema.safeParse({ enabled: true });
    expect(result.success).toBe(false);
  });

  it("rejects empty teamIds", () => {
    const config = {
      enabled: true,
      dailyTokenBudget: 5000000,
      slackChannelId: "C0123456789",
      teamIds: [],
    };
    const result = PmAgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects maxInFlight < 1", () => {
    const config = {
      enabled: true,
      dailyTokenBudget: 5000000,
      slackChannelId: "C0123456789",
      teamIds: ["team-abc"],
      maxInFlight: 0,
    };
    const result = PmAgentConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direct schema regression coverage (#24)
//
// These tests exist so that a future zod migration or schema edit cannot
// silently change a default or drop a field without a failing test. Every
// case calls PmAgentConfigSchema.parse() directly rather than relying on a
// downstream consumer's behaviour. Mirrors the stageModels coverage added in
// PR #10 — defaults here are business-critical for PM Agent throughput.
// ---------------------------------------------------------------------------
describe("PmAgentConfigSchema — full coverage", () => {
  const minimalRequired = {
    enabled: true,
    dailyTokenBudget: 5_000_000,
    slackChannelId: "C0123456789",
    teamIds: ["team-abc"],
  };

  it("parses a minimal config (only required fields)", () => {
    const parsed = PmAgentConfigSchema.parse(minimalRequired);
    expect(parsed.enabled).toBe(true);
    expect(parsed.dailyTokenBudget).toBe(5_000_000);
    expect(parsed.slackChannelId).toBe("C0123456789");
    expect(parsed.teamIds).toEqual(["team-abc"]);
  });

  it("parses a full config with every optional field set", () => {
    const full: PmAgentConfig = {
      enabled: false,
      cronIntervalMs: 600_000,
      maxInFlight: 7,
      triageBatchSize: 10,
      dailyTokenBudget: 12_000_000,
      slackChannelId: "C9999999999",
      teamIds: ["team-a", "team-b", "team-c"],
      stuckIssueRecovery: false,
      stuckIssueTargetState: "Todo",
      stuckIssueMaxPerTick: 25,
      requirePipelineLabelForPromote: false,
        maxConsecutiveFailures: 3,
    };
    const parsed = PmAgentConfigSchema.parse(full);
    expect(parsed).toEqual(full);
  });

  it("applies defaults for stuck-issue recovery fields", () => {
    const parsed = PmAgentConfigSchema.parse(minimalRequired);
    expect(parsed.stuckIssueRecovery).toBe(true);
    expect(parsed.stuckIssueTargetState).toBe("Backlog");
    expect(parsed.stuckIssueMaxPerTick).toBe(5);
  });

  it("applies defaults for cronIntervalMs, maxInFlight, triageBatchSize", () => {
    const parsed = PmAgentConfigSchema.parse(minimalRequired);
    expect(parsed.cronIntervalMs).toBe(1_800_000);
    expect(parsed.maxInFlight).toBe(3);
    expect(parsed.triageBatchSize).toBe(3);
  });

  it("rejects invalid stuckIssueTargetState enum value", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      stuckIssueTargetState: "Done",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative cronIntervalMs", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      cronIntervalMs: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive dailyTokenBudget", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      dailyTokenBudget: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty slackChannelId", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      slackChannelId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects stuckIssueMaxPerTick < 1", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      stuckIssueMaxPerTick: 0,
      requirePipelineLabelForPromote: false,
        maxConsecutiveFailures: 3,
    });
    expect(result.success).toBe(false);
  });

  it("infers a type matching PmAgentConfig", () => {
    const parsed = PmAgentConfigSchema.parse(minimalRequired);
    expectTypeOf(parsed).toEqualTypeOf<PmAgentConfig>();
  });

  it("accepts a full config with budgets block", () => {
    const parsed = PmAgentConfigSchema.parse({
      ...minimalRequired,
      budgets: {
        default: 5_000_000,
        perTeam: { "team-a": 3_000_000, "team-b": 2_000_000 },
        perRepo: { "github.com/org/repo": 1_500_000 },
        alertChannel: "C_BUDGETS",
      },
    });
    expect(parsed.budgets?.default).toBe(5_000_000);
    expect(parsed.budgets?.perTeam?.["team-a"]).toBe(3_000_000);
    expect(parsed.budgets?.perRepo?.["github.com/org/repo"]).toBe(1_500_000);
    expect(parsed.budgets?.alertChannel).toBe("C_BUDGETS");
  });

  it("accepts a minimal config with no budgets field (backward compat)", () => {
    const parsed = PmAgentConfigSchema.parse(minimalRequired);
    expect(parsed.budgets).toBeUndefined();
  });

  it("accepts stalledStageThresholdMinutes when provided (BEC-210)", () => {
    const parsed = PmAgentConfigSchema.parse({
      ...minimalRequired,
      stalledStageThresholdMinutes: 15,
    });
    expect(parsed.stalledStageThresholdMinutes).toBe(15);
  });

  it("stalledStageThresholdMinutes is absent when not provided (backward compat)", () => {
    const parsed = PmAgentConfigSchema.parse(minimalRequired);
    expect(parsed.stalledStageThresholdMinutes).toBeUndefined();
  });

  it("rejects stalledStageThresholdMinutes < 1", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      stalledStageThresholdMinutes: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive budget values", () => {
    const resultNeg = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      budgets: { default: -1 },
    });
    expect(resultNeg.success).toBe(false);

    const resultZero = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      budgets: { perTeam: { "team-a": 0 } },
    });
    expect(resultZero.success).toBe(false);
  });

  it("rejects empty string keys in perTeam/perRepo", () => {
    const result = PmAgentConfigSchema.safeParse({
      ...minimalRequired,
      budgets: { perTeam: { "": 100 } },
    });
    expect(result.success).toBe(false);
  });
});
