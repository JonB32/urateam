/**
 * Tests for AuthMonitor (BEC-207 / BEC-237) — periodic Claude session health-check.
 *
 * Covers:
 *  - Returns early ONLY when ANTHROPIC_API_KEY is set and CLAUDE_CODE_OAUTH_TOKEN is NOT set.
 *  - When CLAUDE_CODE_OAUTH_TOKEN is set, runs the auth probe regardless of ANTHROPIC_API_KEY.
 *  - Runs `claude auth status` when neither env var is set (mounted-session path).
 *  - On expiry: sends Slack alert (text branches on authMethod) and writes claude.auth_expired
 *    audit event (payload includes authMethod).
 *  - 6-hour throttle: skips check if interval has not elapsed.
 *  - createAuthMonitor stateful wrapper manages lastCheckTime across calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that use the mocked modules.
// vi.mock() is hoisted by vitest, so these run before module initialisation.
// ---------------------------------------------------------------------------

// Mock child_process.execFile used by runAuthMonitorCheck
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock postSlackMessage
vi.mock("../pm/slack-helpers.js", () => ({
  postSlackMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock audit writer
vi.mock("../audit/writer.js", () => ({
  logAuditEventUnchecked: vi.fn().mockResolvedValue(undefined),
}));

// Mock resetAuthCheckCache (auth-monitor calls this to bypass the 5-min cache)
vi.mock("../executor/auth-check.js", () => ({
  resetAuthCheckCache: vi.fn(),
  resolveClaudeAuth: vi.fn(() => ({ method: "session" })),
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
}));

// ---------------------------------------------------------------------------
// Static imports (mocks are in place due to hoisting)
// ---------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { postSlackMessage } from "../pm/slack-helpers.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { runAuthMonitorCheck, createAuthMonitor } from "../executor/auth-monitor.js";

const mockExecFile = vi.mocked(execFile);
const mockPostSlackMessage = vi.mocked(postSlackMessage);
const mockLogAuditEvent = vi.mocked(logAuditEventUnchecked);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateCliSuccess() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(null);
    return {} as any;
  });
}

function simulateCliFailure() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
    cb(new Error("session expired"));
    return {} as any;
  });
}

const SMALL_INTERVAL = 100; // 100 ms — always elapsed unless we use a very recent timestamp

// ---------------------------------------------------------------------------
// Tests: runAuthMonitorCheck
// ---------------------------------------------------------------------------

describe("runAuthMonitorCheck", () => {
  let savedOauthToken: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockPostSlackMessage.mockReset().mockResolvedValue({ ok: true } as any);
    mockLogAuditEvent.mockReset().mockResolvedValue(undefined);
    // Save and clear env vars so each test starts with a clean slate
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    }
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });

  // --- Throttle ---

  it("skips check when interval has not elapsed (lastCheckTime is recent)", async () => {
    const recentTime = Date.now(); // just ran
    await runAuthMonitorCheck(recentTime, {}, 60_000); // 60-second interval
    // Should not run execFile because interval hasn't elapsed
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("runs check when interval has elapsed (lastCheckTime = 0 = never)", async () => {
    simulateCliSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  // --- Env-var skip logic (BEC-237) ---

  it("skips check without subprocess when ANTHROPIC_API_KEY is set and CLAUDE_CODE_OAUTH_TOKEN is NOT set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("runs the auth probe when CLAUDE_CODE_OAUTH_TOKEN is set (OAuth tokens can expire)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateCliSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("runs the auth probe when both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set", async () => {
    // CLAUDE_CODE_OAUTH_TOKEN takes precedence — it can expire even if ANTHROPIC_API_KEY is also set
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    simulateCliSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("runs the auth probe when neither env var is set (mounted-session path)", async () => {
    simulateCliSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  // --- OAuth token probe — success ---

  it("does not alert when CLAUDE_CODE_OAUTH_TOKEN probe succeeds", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateCliSuccess();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
    }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // --- OAuth token probe — failure (BEC-237 core scenario) ---

  it("sends Slack alert with oauth-token instructions when CLAUDE_CODE_OAUTH_TOKEN probe fails", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateCliFailure();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-bot-token",
      slackErrorChannel: "CERROR",
    }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).toHaveBeenCalledTimes(1);
    const [calledToken, calledPayload] = mockPostSlackMessage.mock.calls[0] as [
      string,
      { channel: string; text: string },
    ];
    expect(calledToken).toBe("xoxb-bot-token");
    expect(calledPayload.channel).toBe("CERROR");
    // Alert text should mention setup-token, not claude login
    expect(calledPayload.text).toContain("setup-token");
    expect(calledPayload.text).not.toContain("claude login");
  });

  it("logs claude.auth_expired with authMethod=oauth-token when CLAUDE_CODE_OAUTH_TOKEN probe fails", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateCliFailure();
    const fakeDb = {} as any;
    await runAuthMonitorCheck(0, { db: fakeDb }, SMALL_INTERVAL);
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const [calledDb, calledEvent] = mockLogAuditEvent.mock.calls[0];
    expect(calledDb).toBe(fakeDb);
    expect(calledEvent.eventType).toBe("claude.auth_expired");
    expect(calledEvent.actor).toBe("system");
    expect(calledEvent.payload).toMatchObject({
      detectedAt: expect.any(String),
      authMethod: "oauth-token",
    });
  });

  it("sends oauth-token Slack alert when both env vars set and probe fails", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    simulateCliFailure();
    const fakeDb = {} as any;
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
      db: fakeDb,
    }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).toHaveBeenCalledTimes(1);
    expect((mockPostSlackMessage.mock.calls[0][1] as { text: string }).text).toContain("setup-token");
    const [, calledEvent] = mockLogAuditEvent.mock.calls[0];
    expect(calledEvent.payload.authMethod).toBe("oauth-token");
  });

  // --- Session valid ---

  it("runs subprocess and skips alerts when mounted session is valid", async () => {
    simulateCliSuccess();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
    }, SMALL_INTERVAL);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // --- Mounted session expired (existing behavior, preserved) ---

  it("sends Slack alert to configured channel when mounted session is expired", async () => {
    simulateCliFailure();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-bot-token",
      slackErrorChannel: "CERROR",
    }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).toHaveBeenCalledTimes(1);
    expect(mockPostSlackMessage).toHaveBeenCalledWith(
      "xoxb-bot-token",
      expect.objectContaining({ channel: "CERROR" }),
    );
  });

  it("Slack alert for mounted-session expiry mentions claude login, not setup-token", async () => {
    simulateCliFailure();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
    }, SMALL_INTERVAL);
    const text = (mockPostSlackMessage.mock.calls[0][1] as { text: string }).text;
    expect(text).toContain("claude login");
  });

  it("logs claude.auth_expired audit event with authMethod=mounted-session when session expired", async () => {
    simulateCliFailure();
    const fakeDb = {} as any;
    await runAuthMonitorCheck(0, { db: fakeDb }, SMALL_INTERVAL);
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const [calledDb, calledEvent] = mockLogAuditEvent.mock.calls[0];
    expect(calledDb).toBe(fakeDb);
    expect(calledEvent.eventType).toBe("claude.auth_expired");
    expect(calledEvent.actor).toBe("system");
    expect(calledEvent.payload).toMatchObject({
      detectedAt: expect.any(String),
      authMethod: "mounted-session",
    });
  });

  it("does not throw when Slack post fails", async () => {
    simulateCliFailure();
    mockPostSlackMessage.mockRejectedValue(new Error("network error"));
    await expect(
      runAuthMonitorCheck(0, {
        slackBotToken: "xoxb-test",
        slackErrorChannel: "CTEST",
      }, SMALL_INTERVAL)
    ).resolves.not.toThrow();
  });

  it("skips Slack when no slackBotToken configured", async () => {
    simulateCliFailure();
    await runAuthMonitorCheck(0, { slackErrorChannel: "CTEST" }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
  });

  it("skips Slack when no slackErrorChannel configured", async () => {
    simulateCliFailure();
    await runAuthMonitorCheck(0, { slackBotToken: "xoxb-test" }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
  });

  // --- Return value (lastCheckTime update) ---

  it("returns updated timestamp after running", async () => {
    simulateCliSuccess();
    const before = Date.now();
    const returned = await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    const after = Date.now();
    expect(returned).toBeGreaterThanOrEqual(before);
    expect(returned).toBeLessThanOrEqual(after);
  });

  it("returns original lastCheckTime when interval has not elapsed", async () => {
    const recentTime = Date.now();
    const returned = await runAuthMonitorCheck(recentTime, {}, 60_000);
    expect(returned).toBe(recentTime);
  });
});

// ---------------------------------------------------------------------------
// Tests: createAuthMonitor stateful wrapper
// ---------------------------------------------------------------------------

describe("createAuthMonitor", () => {
  let savedOauthToken: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockPostSlackMessage.mockReset().mockResolvedValue({ ok: true } as any);
    mockLogAuditEvent.mockReset().mockResolvedValue(undefined);
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    }
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });

  it("tick() runs the check and handles errors gracefully", async () => {
    simulateCliSuccess();
    const monitor = createAuthMonitor({}, SMALL_INTERVAL);
    await expect(monitor.tick()).resolves.not.toThrow();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("tick() is throttled — second call immediately after first is a no-op", async () => {
    simulateCliSuccess();
    const monitor = createAuthMonitor({}, 60_000); // 60s interval
    await monitor.tick(); // first tick — runs
    await monitor.tick(); // second tick immediately — throttled
    expect(mockExecFile).toHaveBeenCalledTimes(1); // only one subprocess
  });

  it("tick() skips session check when only ANTHROPIC_API_KEY is set (static key, never expires)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    const monitor = createAuthMonitor({}, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("tick() runs probe when CLAUDE_CODE_OAUTH_TOKEN is set (OAuth tokens can expire)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateCliSuccess();
    const monitor = createAuthMonitor({}, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("tick() sends alert on expired OAuth token and logs audit event with authMethod=oauth-token", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateCliFailure();
    const fakeDb = {} as any;
    const monitor = createAuthMonitor({
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CALERTS",
      db: fakeDb,
    }, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockPostSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      expect.objectContaining({ channel: "CALERTS" }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const [, calledEvent] = mockLogAuditEvent.mock.calls[0];
    expect(calledEvent.eventType).toBe("claude.auth_expired");
    expect(calledEvent.payload.authMethod).toBe("oauth-token");
  });

  it("tick() sends alert on expired mounted session and logs audit event with authMethod=mounted-session", async () => {
    simulateCliFailure();
    const fakeDb = {} as any;
    const monitor = createAuthMonitor({
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CALERTS",
      db: fakeDb,
    }, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockPostSlackMessage).toHaveBeenCalledWith(
      "xoxb-test",
      expect.objectContaining({ channel: "CALERTS" }),
    );
    expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    const [, calledEvent] = mockLogAuditEvent.mock.calls[0];
    expect(calledEvent.eventType).toBe("claude.auth_expired");
    expect(calledEvent.payload.authMethod).toBe("mounted-session");
  });
});
