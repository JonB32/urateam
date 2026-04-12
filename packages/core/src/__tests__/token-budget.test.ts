import { describe, it, expect, vi } from "vitest";
import { PipelineConfigSchema, type Notifier, type PipelineRun, type DailyTokenSummary } from "../types.js";
import { CompositeNotifier } from "../notifier/composite.js";
import { SlackNotifier } from "../notifier/slack.js";
import { DiscordNotifier } from "../notifier/discord.js";
import { LinearNotifier } from "../notifier/linear.js";

// --- Helpers ---

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "run-12345678-abcd",
    issueId: "TEAM-123",
    issueTitle: "Fix login bug",
    pipelineKey: "auto-implement",
    repoUrl: "https://github.com/org/repo",
    branch: "fix/login-bug",
    status: "running",
    startedAt: new Date("2026-01-01"),
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<DailyTokenSummary> = {}): DailyTokenSummary {
  return {
    date: "2026-03-31",
    totalInputTokens: 50000,
    totalOutputTokens: 25000,
    runsCompleted: 5,
    runsFailed: 1,
    ...overrides,
  };
}

function createMockNotifier(): Notifier & {
  onTokenBudgetAlert: ReturnType<typeof vi.fn>;
  onDailyTokenSummary: ReturnType<typeof vi.fn>;
} {
  return {
    onPipelineStart: vi.fn().mockResolvedValue(undefined),
    onStageComplete: vi.fn().mockResolvedValue(undefined),
    onPipelineComplete: vi.fn().mockResolvedValue(undefined),
    onPipelineFailed: vi.fn().mockResolvedValue(undefined),
    onTokenBudgetAlert: vi.fn().mockResolvedValue(undefined),
    onDailyTokenSummary: vi.fn().mockResolvedValue(undefined),
  };
}

// --- Schema Validation ---

describe("PipelineConfigSchema maxTokens", () => {
  const baseConfig = {
    name: "test",
    stages: ["implement"],
    retry: { maxAttempts: 1, strategy: "fail-fast" },
    review: { requiredApprovals: 1 },
    prStrategy: "draft",
  };

  it("accepts config without maxTokens", () => {
    const result = PipelineConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
  });

  it("accepts config with valid maxTokens", () => {
    const result = PipelineConfigSchema.safeParse({ ...baseConfig, maxTokens: 1_000_000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxTokens).toBe(1_000_000);
    }
  });

  it("rejects maxTokens of 0", () => {
    const result = PipelineConfigSchema.safeParse({ ...baseConfig, maxTokens: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative maxTokens", () => {
    const result = PipelineConfigSchema.safeParse({ ...baseConfig, maxTokens: -100 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer maxTokens", () => {
    const result = PipelineConfigSchema.safeParse({ ...baseConfig, maxTokens: 1000.5 });
    expect(result.success).toBe(false);
  });
});

// --- Composite Notifier Forwarding ---

describe("CompositeNotifier token budget forwarding", () => {
  it("forwards onTokenBudgetAlert to all notifiers that implement it", async () => {
    const n1 = createMockNotifier();
    const n2 = createMockNotifier();
    const composite = new CompositeNotifier([n1, n2]);
    const run = makeRun();

    await composite.onTokenBudgetAlert(run, 80000, 100000);

    expect(n1.onTokenBudgetAlert).toHaveBeenCalledWith(run, 80000, 100000);
    expect(n2.onTokenBudgetAlert).toHaveBeenCalledWith(run, 80000, 100000);
  });

  it("forwards onDailyTokenSummary to all notifiers that implement it", async () => {
    const n1 = createMockNotifier();
    const n2 = createMockNotifier();
    const composite = new CompositeNotifier([n1, n2]);
    const summary = makeSummary();

    await composite.onDailyTokenSummary(summary);

    expect(n1.onDailyTokenSummary).toHaveBeenCalledWith(summary);
    expect(n2.onDailyTokenSummary).toHaveBeenCalledWith(summary);
  });

  it("skips notifiers that don't implement the optional methods", async () => {
    const minimal: Notifier = {
      onPipelineStart: vi.fn().mockResolvedValue(undefined),
      onStageComplete: vi.fn().mockResolvedValue(undefined),
      onPipelineComplete: vi.fn().mockResolvedValue(undefined),
      onPipelineFailed: vi.fn().mockResolvedValue(undefined),
    };
    const full = createMockNotifier();
    const composite = new CompositeNotifier([minimal, full]);
    const run = makeRun();

    await expect(composite.onTokenBudgetAlert(run, 80000, 100000)).resolves.toBeUndefined();
    expect(full.onTokenBudgetAlert).toHaveBeenCalledWith(run, 80000, 100000);
  });

  it("does not throw when one notifier fails", async () => {
    const failing = createMockNotifier();
    failing.onTokenBudgetAlert.mockRejectedValue(new Error("boom"));
    const passing = createMockNotifier();
    const composite = new CompositeNotifier([failing, passing]);
    const run = makeRun();

    await expect(composite.onTokenBudgetAlert(run, 80000, 100000)).resolves.toBeUndefined();
    expect(passing.onTokenBudgetAlert).toHaveBeenCalled();
  });
});

// --- Slack Notifier ---

describe("SlackNotifier token budget methods", () => {
  it("onTokenBudgetAlert sends Block Kit message", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    const run = makeRun();

    await notifier.onTokenBudgetAlert(run, 80000, 100000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.blocks).toBeDefined();
    expect(body.blocks[0].text.text).toContain("Token Budget Alert");
    expect(body.blocks[1].text.text).toContain("80,000");
    expect(body.blocks[1].text.text).toContain("100,000");
    expect(body.blocks[1].text.text).toContain("80%");

    fetchSpy.mockRestore();
  });

  it("onDailyTokenSummary sends Block Kit message", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const notifier = new SlackNotifier("https://hooks.slack.com/test");

    await notifier.onDailyTokenSummary(makeSummary());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.blocks[0].text.text).toContain("Daily Token Summary");
    expect(body.blocks[0].text.text).toContain("2026-03-31");
    expect(body.blocks[1].text.text).toContain("75,000"); // total
    expect(body.blocks[1].text.text).toContain("5"); // runs completed

    fetchSpy.mockRestore();
  });
});

// --- Discord Notifier ---

describe("DiscordNotifier token budget methods", () => {
  it("onTokenBudgetAlert sends embed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");
    const run = makeRun();

    await notifier.onTokenBudgetAlert(run, 80000, 100000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.embeds[0].title).toBe("Token Budget Alert");
    expect(body.embeds[0].description).toContain("80,000");
    expect(body.embeds[0].description).toContain("100,000");

    fetchSpy.mockRestore();
  });

  it("onDailyTokenSummary sends embed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");

    await notifier.onDailyTokenSummary(makeSummary());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.embeds[0].title).toContain("Daily Token Summary");
    expect(body.embeds[0].description).toContain("75,000"); // total

    fetchSpy.mockRestore();
  });
});

// --- Linear Notifier ---

describe("LinearNotifier token budget methods", () => {
  class TestableLinearNotifier extends LinearNotifier {
    public comments: { issueId: string; body: string }[] = [];

    constructor() {
      super({ apiKey: "test-key" });
      (this as any).postComment = async (issueId: string, body: string) => {
        this.comments.push({ issueId, body });
      };
    }
  }

  it("onTokenBudgetAlert posts comment with budget warning", async () => {
    const notifier = new TestableLinearNotifier();
    const run = makeRun();

    await notifier.onTokenBudgetAlert(run, 80000, 100000);

    expect(notifier.comments).toHaveLength(1);
    const body = notifier.comments[0].body;
    expect(body).toContain("Token Budget Warning");
    expect(body).toContain("80,000");
    expect(body).toContain("100,000");
    expect(body).toContain("80%");
    expect(body).toContain("aborted");
    expect(notifier.comments[0].issueId).toBe("TEAM-123");
  });
});
