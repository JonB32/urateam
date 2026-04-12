import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackAlertManager, SlackAlertStream, createSlackAlertStream } from "../notifier/slack-alerts.js";
import type { AlertEntry } from "../notifier/slack-alerts.js";

const BOT_TOKEN = "xoxb-test-token";
const CHANNEL_ID = "C123456";

function makeErrorEntry(overrides: Partial<AlertEntry> = {}): AlertEntry {
  return {
    level: 50,
    component: "PipelineRunner",
    msg: "something went wrong",
    issueId: "TEAM-42",
    runId: "run-abcdefgh-1234",
    stage: "implement",
    ...overrides,
  };
}

describe("SlackAlertManager", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a Slack message for error-level entries (level 50)", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry());

    // Give the fire-and-forget promise a tick to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);

    const body = JSON.parse(opts.body);
    expect(body.channel).toBe(CHANNEL_ID);
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  it("sends a Slack message for fatal-level entries (level 60)", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ level: 60 }));

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT send for info-level entries (level 30)", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ level: 30 }));

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT send for warn-level entries (level 40)", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ level: 40 }));

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rate limits duplicate errors within 5 minutes", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    const entry = makeErrorEntry();
    manager.handleEntry(entry);
    manager.handleEntry(entry); // same entry — should be suppressed

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends again after rate limit expires (different key)", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ msg: "error one" }));
    manager.handleEntry(makeErrorEntry({ msg: "error two" })); // different message

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("re-sends same error after rate limit window expires", async () => {
    vi.useFakeTimers();
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    const entry = makeErrorEntry();

    manager.handleEntry(entry);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Still within 5 min — suppressed
    manager.handleEntry(entry);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past the 5-minute window
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    manager.handleEntry(entry);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("includes auth error remediation block for 401 errors", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ msg: "Request failed with 401 unauthorized" }));

    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const hasRemediation = body.blocks.some(
      (b: any) =>
        b.type === "section" &&
        typeof b.text?.text === "string" &&
        b.text.text.includes("Remediation"),
    );
    expect(hasRemediation).toBe(true);
  });

  it("uses 🔑 title for auth errors", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ msg: "authentication failed" }));

    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const header = body.blocks.find((b: any) => b.type === "header");
    expect(header.text.text).toContain("Auth Error");
  });

  it("uses 🤖 title for PM Agent errors", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ component: "PmAgent:triage", issueId: undefined }));

    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const header = body.blocks.find((b: any) => b.type === "header");
    expect(header.text.text).toContain("PM Agent Error");
  });

  it("uses 🔧 title for git errors", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ component: "git", msg: "push failed" }));

    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const header = body.blocks.find((b: any) => b.type === "header");
    expect(header.text.text).toContain("Git Operation Failed");
  });

  it("escapes mrkdwn special characters in error messages", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry({ msg: "<!channel> <script>alert(1)</script> & stuff" }));

    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const section = body.blocks.find((b: any) => b.type === "section");
    expect(section.text.text).not.toContain("<!channel>");
    expect(section.text.text).toContain("&lt;!channel&gt;");
    expect(section.text.text).toContain("&amp; stuff");
  });

  it("includes issueId, runId, stage in context block", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(makeErrorEntry());

    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const ctx = body.blocks.find((b: any) => b.type === "context");
    expect(ctx).toBeDefined();
    const text = ctx.elements[0].text;
    expect(text).toContain("TEAM-42");
    expect(text).toContain("run-abcd"); // first 8 chars of runId
    expect(text).toContain("implement");
    expect(text).toContain("PipelineRunner");
  });

  it("extracts error message from err.message field", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    manager.handleEntry(
      makeErrorEntry({ err: { message: "ENOENT: no such file", stack: "..." }, msg: "git failed" }),
    );

    await new Promise((r) => setTimeout(r, 0));

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const section = body.blocks.find((b: any) => b.type === "section");
    expect(section.text.text).toContain("ENOENT: no such file");
  });

  it("does not throw when fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);

    // Should not throw
    expect(() => manager.handleEntry(makeErrorEntry())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("SlackAlertStream", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses pino JSON lines and forwards error entries", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    const stream = createSlackAlertStream(manager);

    const logLine = JSON.stringify({
      level: 50,
      component: "PipelineRunner",
      msg: "stage failed",
      issueId: "TEST-1",
    });

    await new Promise<void>((resolve, reject) => {
      stream.write(Buffer.from(logLine + "\n"), (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("ignores non-error log lines", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    const stream = createSlackAlertStream(manager);

    const logLine = JSON.stringify({ level: 30, component: "PipelineRunner", msg: "running" });

    await new Promise<void>((resolve, reject) => {
      stream.write(Buffer.from(logLine), (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON without throwing", async () => {
    const manager = new SlackAlertManager(BOT_TOKEN, CHANNEL_ID);
    const stream = createSlackAlertStream(manager);

    await new Promise<void>((resolve, reject) => {
      stream.write(Buffer.from("not valid json\n"), (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
