import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordNotifier } from "../notifier/discord.js";
import type { PipelineRun, DailyTokenSummary } from "../types.js";

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

describe("DiscordNotifier", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends embed payload on pipeline start", async () => {
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");
    await notifier.onPipelineStart(makeRun());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/webhooks/test");

    const body = JSON.parse(options.body);
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe("Pipeline Started");
    expect(body.embeds[0].description).toContain("Fix login bug");
    expect(body.embeds[0].description).toContain("auto-implement");
  });

  it("is no-op when webhookUrl is undefined", async () => {
    const notifier = new DiscordNotifier();
    await notifier.onPipelineStart(makeRun());
    await notifier.onStageComplete(makeRun(), "test", {
      status: "completed", inputTokens: 100, outputTokens: 50, turns: 3,
    });
    await notifier.onPipelineComplete(makeRun(), {
      prUrl: "https://example.com/pr/1", totalInputTokens: 1000, totalOutputTokens: 500, stagesCompleted: 3,
    });
    await notifier.onPipelineFailed(makeRun(), {
      stage: "test", message: "boom", retriesExhausted: false,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses correct colors (yellow start, green complete, red failed)", async () => {
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");

    // Pipeline start -> yellow (0xffaa00)
    await notifier.onPipelineStart(makeRun());
    let body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].color).toBe(0xffaa00);

    // Stage complete (success) -> green (0x00ff00)
    await notifier.onStageComplete(makeRun(), "implement", {
      status: "completed", inputTokens: 100, outputTokens: 50, turns: 3,
    });
    body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.embeds[0].color).toBe(0x00ff00);

    // Stage complete (failed) -> red (0xff0000)
    await notifier.onStageComplete(makeRun(), "test", {
      status: "failed", inputTokens: 100, outputTokens: 50, turns: 3, errorMessage: "oops",
    });
    body = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(body.embeds[0].color).toBe(0xff0000);

    // Pipeline complete -> green (0x00ff00)
    await notifier.onPipelineComplete(makeRun(), {
      prUrl: "https://example.com/pr/1", totalInputTokens: 1000, totalOutputTokens: 500, stagesCompleted: 3,
    });
    body = JSON.parse(mockFetch.mock.calls[3][1].body);
    expect(body.embeds[0].color).toBe(0x00ff00);

    // Pipeline failed -> red (0xff0000)
    await notifier.onPipelineFailed(makeRun(), {
      stage: "test", message: "boom", retriesExhausted: true,
    });
    body = JSON.parse(mockFetch.mock.calls[4][1].body);
    expect(body.embeds[0].color).toBe(0xff0000);
  });

  it("does not throw on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifier.onPipelineStart(makeRun())).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("includes PR link in pipeline complete", async () => {
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");
    await notifier.onPipelineComplete(makeRun(), {
      prUrl: "https://github.com/org/repo/pull/42",
      totalInputTokens: 5000,
      totalOutputTokens: 2500,
      stagesCompleted: 3,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].description).toContain("View PR");
    expect(body.embeds[0].description).toContain("https://github.com/org/repo/pull/42");
  });

  it("shows retries exhausted in pipeline failed", async () => {
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");
    await notifier.onPipelineFailed(makeRun(), {
      stage: "test", message: "Tests failed", retriesExhausted: true,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].description).toContain("Retries exhausted");
  });

  it("sends token budget alert embed with pipeline name and usage percentage", async () => {
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");
    await notifier.onTokenBudgetAlert(makeRun(), 80000, 100000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds).toHaveLength(1);

    const embed = body.embeds[0];
    expect(embed.title).toContain("Token Budget Alert");
    expect(embed.description).toContain("auto-implement");
    expect(embed.description).toContain("80%");
    expect(embed.description).toContain("80,000");
    expect(embed.description).toContain("100,000");
    expect(embed.color).toBe(0xffaa00); // yellow for warning
  });

  it("sends daily token summary embed", async () => {
    const notifier = new DiscordNotifier("https://discord.com/api/webhooks/test");
    const summary: DailyTokenSummary = {
      date: "2026-04-08",
      totalInputTokens: 50000,
      totalOutputTokens: 25000,
      runsCompleted: 12,
      runsFailed: 2,
    };
    await notifier.onDailyTokenSummary(summary);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds).toHaveLength(1);

    const embed = body.embeds[0];
    expect(embed.title).toContain("Daily Token Summary");
    expect(embed.title).toContain("2026-04-08");
    expect(embed.description).toContain("75,000");   // total tokens
    expect(embed.description).toContain("50,000");   // input tokens
    expect(embed.description).toContain("25,000");   // output tokens
    expect(embed.description).toContain("12");        // runs completed
    expect(embed.description).toContain("2");         // runs failed
    expect(embed.color).toBe(0x00ff00); // green for informational
  });

  it("token budget alert is no-op when webhookUrl is undefined", async () => {
    const notifier = new DiscordNotifier();
    await notifier.onTokenBudgetAlert(makeRun(), 80000, 100000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("daily token summary is no-op when webhookUrl is undefined", async () => {
    const notifier = new DiscordNotifier();
    const summary: DailyTokenSummary = {
      date: "2026-04-08",
      totalInputTokens: 50000,
      totalOutputTokens: 25000,
      runsCompleted: 12,
      runsFailed: 2,
    };
    await notifier.onDailyTokenSummary(summary);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
