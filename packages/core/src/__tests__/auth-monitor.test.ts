/**
 * Tests for AuthMonitor (BEC-207) — periodic Claude session health-check.
 *
 * Covers:
 *  - Returns early when CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY is set.
 *  - Runs `claude auth status` only when neither env var is set.
 *  - On expiry: sends Slack alert and writes claude.auth_expired audit event.
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

  // --- Env-var short-circuit (AC #8) ---

  it("returns early without subprocess when CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("returns early without subprocess when ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("returns early without subprocess when both env vars are set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
    await runAuthMonitorCheck(0, {}, SMALL_INTERVAL);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // --- Session valid ---

  it("runs subprocess and skips alerts when session is valid", async () => {
    simulateCliSuccess();
    await runAuthMonitorCheck(0, {
      slackBotToken: "xoxb-test",
      slackErrorChannel: "CTEST",
    }, SMALL_INTERVAL);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockPostSlackMessage).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  // --- Session expired (AC #7, #15) ---

  it("sends Slack alert to configured channel when session is expired", async () => {
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

  it("logs claude.auth_expired audit event when session is expired and db provided (AC #7)", async () => {
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
// Tests: createAuthMonitor stateful wrapper (AC #6)
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

  it("tick() skips session check when CLAUDE_CODE_OAUTH_TOKEN is set (AC #8)", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    const monitor = createAuthMonitor({}, SMALL_INTERVAL);
    await monitor.tick();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("tick() sends alert on expired session and logs audit event (AC #6, #7)", async () => {
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
  });
});
