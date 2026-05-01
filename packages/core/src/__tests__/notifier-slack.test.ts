import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackNotifier } from "../notifier/slack.js";
import type { PipelineRun, StageResult, PipelineResult, PipelineError, DailyTokenSummary } from "../types.js";

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

describe("SlackNotifier", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Block Kit payload on pipeline start", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.onPipelineStart(makeRun());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/test");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0].type).toBe("section");
    expect(body.blocks[0].text.type).toBe("mrkdwn");
    expect(body.blocks[0].text.text).toContain("Pipeline started");
    expect(body.blocks[0].text.text).toContain("Fix login bug");
    expect(body.blocks[0].text.text).toContain("auto-implement");
  });

  it("is no-op when webhookUrl is undefined", async () => {
    const notifier = new SlackNotifier();
    await notifier.onPipelineStart(makeRun());
    await notifier.onStageComplete(makeRun(), "test", {
      status: "completed", inputTokens: 100, outputTokens: 50, turns: 3, stageRunId: "sr1",
    });
    await notifier.onPipelineComplete(makeRun(), {
      prUrl: "https://example.com/pr/1", totalInputTokens: 1000, totalOutputTokens: 500, stagesCompleted: 3,
    });
    await notifier.onPipelineFailed(makeRun(), {
      stage: "test", message: "boom", retriesExhausted: false,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not throw on fetch error", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const notifier = new SlackNotifier("https://hooks.slack.com/test");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifier.onPipelineStart(makeRun())).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });

  it("sends stage complete payload", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.onStageComplete(makeRun(), "implement", {
      status: "completed", inputTokens: 1000, outputTokens: 500, turns: 5, stageRunId: "sr2",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain("Stage complete: implement");
  });

  it("sends pipeline complete payload with PR link", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.onPipelineComplete(makeRun(), {
      prUrl: "https://github.com/org/repo/pull/42",
      totalInputTokens: 5000,
      totalOutputTokens: 2500,
      stagesCompleted: 3,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain("Pipeline complete");
    expect(body.blocks[0].text.text).toContain("View PR");
  });

  it("sends pipeline failed payload", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.onPipelineFailed(makeRun(), {
      stage: "test", message: "Tests failed", retriesExhausted: true,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain("Pipeline failed");
    expect(body.blocks[0].text.text).toContain("Retries exhausted");
  });

  it("sends token budget alert Block Kit message with pipeline name and usage percentage", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.onTokenBudgetAlert(makeRun(), 80000, 100000);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);

    // Should have a header block with alert title
    const headerBlock = body.blocks.find((b: { type: string }) => b.type === "header");
    expect(headerBlock).toBeDefined();
    expect(headerBlock.text.text).toContain("Token Budget Alert");

    // Should have a section block with usage percentage
    const sectionBlock = body.blocks.find((b: { type: string }) => b.type === "section");
    expect(sectionBlock).toBeDefined();
    expect(sectionBlock.text.text).toContain("80%");
    expect(sectionBlock.text.text).toContain("80,000");
    expect(sectionBlock.text.text).toContain("100,000");

    // Should have a context block with pipeline name
    const contextBlock = body.blocks.find((b: { type: string }) => b.type === "context");
    expect(contextBlock).toBeDefined();
    expect(contextBlock.elements[0].text).toContain("auto-implement");
  });

  it("sends daily token summary Block Kit message", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
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

    // Should have a header block with the date
    const headerBlock = body.blocks.find((b: { type: string }) => b.type === "header");
    expect(headerBlock).toBeDefined();
    expect(headerBlock.text.text).toContain("Daily Token Summary");
    expect(headerBlock.text.text).toContain("2026-04-08");

    // Should have a section block with token totals and run counts
    const sectionBlock = body.blocks.find((b: { type: string }) => b.type === "section");
    expect(sectionBlock).toBeDefined();
    expect(sectionBlock.text.text).toContain("75,000");   // total tokens
    expect(sectionBlock.text.text).toContain("50,000");   // input tokens
    expect(sectionBlock.text.text).toContain("25,000");   // output tokens
    expect(sectionBlock.text.text).toContain("12");        // runs completed
    expect(sectionBlock.text.text).toContain("2");         // runs failed
  });

  it("token budget alert is no-op when webhookUrl is undefined", async () => {
    const notifier = new SlackNotifier();
    await notifier.onTokenBudgetAlert(makeRun(), 80000, 100000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("daily token summary is no-op when webhookUrl is undefined", async () => {
    const notifier = new SlackNotifier();
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
