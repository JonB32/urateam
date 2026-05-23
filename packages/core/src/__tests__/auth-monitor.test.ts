/**
 * Tests for AuthMonitor (BEC-207 / BEC-237 / BEC-244).
 *
 * Covers:
 *  - Returns early ONLY when ANTHROPIC_API_KEY is set and CLAUDE_CODE_OAUTH_TOKEN is NOT set.
 *  - When CLAUDE_CODE_OAUTH_TOKEN is set, runs the real-API probe regardless of ANTHROPIC_API_KEY.
 *  - Runs the real-API probe when neither env var is set (mounted-session path).
 *  - On auth expiry (probe returns auth error): sends Slack alert + writes claude.auth_expired event.
 *  - On network error: probe returns { valid: true } (fail-open) — no alert, no audit event.
 *  - 6-hour throttle: skips check if interval has not elapsed.
 *  - createAuthMonitor stateful wrapper manages lastCheckTime across calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports that use the mocked modules.
// vi.mock() is hoisted by vitest, so these run before module initialisation.
// ---------------------------------------------------------------------------

// Mock probeClaudeAuth (and other exports) from auth-check.js.
// auth-monitor.ts imports probeClaudeAuth from there; mocking at module level
// lets each test control the probe outcome cleanly.
vi.mock("../executor/auth-check.js", () => ({
  resetAuthCheckCache: vi.fn(),
  resolveClaudeAuth: vi.fn(() => ({ method: "session" })),
  isClaudeAuthValid: vi.fn().mockResolvedValue(true),
  probeClaudeAuth: vi.fn(),
}));

// Mock postSlackMessage
vi.mock("../pm/slack-helpers.js", () => ({
  postSlackMessage: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock audit writer
vi.mock("../audit/writer.js", () => ({
  logAuditEventUnchecked: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Static imports (mocks are in place due to hoisting)
// ---------------------------------------------------------------------------
import { postSlackMessage } from "../pm/slack-helpers.js";
import { logAuditEventUnchecked } from "../audit/writer.js";
import { probeClaudeAuth } from "../executor/auth-check.js";
import { runAuthMonitorCheck, createAuthMonitor } from "../executor/auth-monitor.js";

const mockProbeClaudeAuth = vi.mocked(probeClaudeAuth);
const mockPostSlackMessage = vi.mocked(postSlackMessage);
const mockLogAuditEvent = vi.mocked(logAuditEventUnchecked);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateProbeSuccess() {
  mockProbeClaudeAuth.mockResolvedValue({ valid: true });
}

/** Auth failure — probe detects a 401 from the API. */
function simulateProbeAuthFailure() {
  mockProbeClaudeAuth.mockResolvedValue({ valid: false, reason: "auth" });
}

/** Network / transient error — probe fails open (no alert should fire). */
function simulateProbeNetworkError() {
  // Fail-open: probeClaudeAuth returns { valid: true } on network errors
  mockProbeClaudeAuth.mockResolvedValue({ valid: true });
}

const SMALL_INTERVAL = 100; // 100 ms — always elapsed unless we pass a very recent timestamp

// ---------------------------------------------------------------------------
// Tests: runAuthMonitorCheck
// ---------------------------------------------------------------------------

describe("runAuthMonitorCheck", () => {
  let savedOauthToken: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    mockProbeClaudeAuth.mockReset();
    mockPostSlackMessage.mockReset().mockResolvedValue({ ok: true } as any);
    mockLogAuditEvent.mockReset().mockResolvedValue(undefined);
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
  });

  // --- Throttle ---

  it("skips check when interval has not elapsed (lastCheckTime is recent)", async () => {
    const recentTime = Date.now();
    await runAuthMonitorCheck(recentTime, {}, 60_000);
    expect(mockProbeClaudeAuth).not.toHaveBeenCalled();
  });

  it("runs check when interval has elapsed (lastCheckTime = 0 = never)", async () => {
    simulateProbeSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
  });

  // --- Env-var skip logic (BEC-237) ---

  it("skips probe when ANTHROPIC_API_KEY is set and CLAUDE_CODE_OAUTH_TOKEN is NOT set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockProbeClaudeAuth).not.toHaveBeenCalled();
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("runs the auth probe when CLAUDE_CODE_OAUTH_TOKEN is set (OAuth tokens can expire)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateProbeSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
  });

  it("runs the auth probe when both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    simulateProbeSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
  });

  it("runs the auth probe when neither env var is set (mounted-session path)", async () => {
    simulateProbeSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
  });

  it("passes 15-second timeout to probeClaudeAuth", async () => {
    simulateProbeSuccess();
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockProbeClaudeAuth).toHaveBeenCalledWith(15_000);
  });

  // --- Probe success → no alert ---

  it("does not alert when CLAUDE_CODE_OAUTH_TOKEN probe succeeds", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateProbeSuccess();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
    }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // --- Probe auth failure (BEC-244 core scenario) ---

  it("sends Slack alert with oauth-token instructions when CLAUDE_CODE_OAUTH_TOKEN probe detects auth failure", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateProbeAuthFailure();
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
    expect(calledPayload.text).toContain("setup-token");
    expect(calledPayload.text).not.toContain("claude login");
  });

  it("logs claude.auth_expired with authMethod=oauth-token when CLAUDE_CODE_OAUTH_TOKEN probe detects auth failure", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateProbeAuthFailure();
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

  it("sends oauth-token Slack alert when both env vars set and probe detects auth failure", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    simulateProbeAuthFailure();
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

  // --- Probe network error → fail-open (BEC-244 AC) ---

  it("does NOT fire an alert when probe encounters a network error (fail-open)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    // probeClaudeAuth returns { valid: true } for network/transient errors
    simulateProbeNetworkError();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
      db: {} as any,
    }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("does NOT fire an audit event when probe encounters a network error (fail-open)", async () => {
    simulateProbeNetworkError();
    const fakeDb = {} as any;
    await runAuthMonitorCheck(0, { db: fakeDb }, SMALL_INTERVAL);
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // --- Session valid ---

  it("runs probe and skips alerts when mounted session is valid", async () => {
    simulateProbeSuccess();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
    }, SMALL_INTERVAL);
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // --- Mounted session expired ---

  it("sends Slack alert to configured channel when mounted session probe detects auth failure", async () => {
    simulateProbeAuthFailure();
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

  it("Slack alert for mounted-session auth failure mentions claude login, not setup-token", async () => {
    simulateProbeAuthFailure();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
    }, SMALL_INTERVAL);
    const text = (mockPostSlackMessage.mock.calls[0][1] as { text: string }).text;
    expect(text).toContain("claude login");
  });

  it("logs claude.auth_expired audit event with authMethod=mounted-session when session probe detects auth failure", async () => {
    simulateProbeAuthFailure();
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
    simulateProbeAuthFailure();
    mockPostSlackMessage.mockRejectedValue(new Error("network error"));
    await expect(
      runAuthMonitorCheck(0, {
        slackBotToken: "xoxb-test",
        slackErrorChannel: "CTEST",
      }, SMALL_INTERVAL)
    ).resolves.not.toThrow();
  });

  it("skips Slack when no slackBotToken configured", async () => {
    simulateProbeAuthFailure();
    await runAuthMonitorCheck(0, { slackErrorChannel: "CTEST" }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
  });

  it("skips Slack when no slackErrorChannel configured", async () => {
    simulateProbeAuthFailure();
    await runAuthMonitorCheck(0, { slackBotToken: "xoxb-test" }, SMALL_INTERVAL);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
  });

  // --- Return value ---

  it("returns updated timestamp after running", async () => {
    simulateProbeSuccess();
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
    mockProbeClaudeAuth.mockReset();
    mockPostSlackMessage.mockReset().mockResolvedValue({ ok: true } as any);
    mockLogAuditEvent.mockReset().mockResolvedValue(undefined);
    savedOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (savedOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauthToken;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
  });

  it("tick() runs the probe and handles errors gracefully", async () => {
    simulateProbeSuccess();
    const monitor = createAuthMonitor({}, SMALL_INTERVAL);
    await expect(monitor.tick()).resolves.not.toThrow();
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
  });

  it("tick() is throttled — second call immediately after first is a no-op", async () => {
    simulateProbeSuccess();
    const monitor = createAuthMonitor({}, 60_000);
    await monitor.tick();
    await monitor.tick();
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
  });

  it("tick() skips probe when only ANTHROPIC_API_KEY is set (static key, never expires)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    const monitor = createAuthMonitor({}, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockProbeClaudeAuth).not.toHaveBeenCalled();
  });

  it("tick() runs probe when CLAUDE_CODE_OAUTH_TOKEN is set (OAuth tokens can expire)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateProbeSuccess();
    const monitor = createAuthMonitor({}, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockProbeClaudeAuth).toHaveBeenCalledTimes(1);
  });

  it("tick() does NOT alert when probe returns network error (fail-open)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateProbeNetworkError();
    const fakeDb = {} as any;
    const monitor = createAuthMonitor({
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CALERTS",
      db: fakeDb,
    }, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("tick() sends alert on auth-failed OAuth token and logs audit event with authMethod=oauth-token", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    simulateProbeAuthFailure();
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

  it("tick() sends alert on auth-failed mounted session and logs audit event with authMethod=mounted-session", async () => {
    simulateProbeAuthFailure();
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
