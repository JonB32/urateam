import { describe, it, expect } from "vitest";
import { PmAgentConfigSchema } from "../pm/types.js";

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
