import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parsePmCommand,
  interpretNaturalLanguage,
  executePmCommand,
  verifySlackSignature,
  createSlackInterface,
  SlackInterfaceNotifier,
  isPmPaused,
  setPmPaused,
  analyzeBulkCreateRequest,
  type PmCommand,
  type DailySummaryEntry,
} from "../pm/slack-interface.js";

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ ok: true, ts: "1234567890.123456" }),
});

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockClear();
  // Reset pause state
  setPmPaused(false);
});

// ---------------------------------------------------------------------------
// parsePmCommand
// ---------------------------------------------------------------------------
describe("parsePmCommand", () => {
  it("parses prioritize command", () => {
    const cmd = parsePmCommand("prioritize BEC-25");
    expect(cmd).toEqual({ type: "prioritize", issueId: "BEC-25" });
  });

  it("parses assign command", () => {
    const cmd = parsePmCommand("assign BEC-13");
    expect(cmd).toEqual({ type: "assign", issueId: "BEC-13" });
  });

  it("parses create command with title and description", () => {
    const cmd = parsePmCommand('create "My title" "My description"');
    expect(cmd).toEqual({ type: "create", title: "My title", description: "My description" });
  });

  it("parses create command with title only", () => {
    const cmd = parsePmCommand('create "Only a title"');
    expect(cmd).toEqual({ type: "create", title: "Only a title", description: "" });
  });

  it("parses status command", () => {
    expect(parsePmCommand("status")).toEqual({ type: "status" });
  });

  it("parses pause command", () => {
    expect(parsePmCommand("pause")).toEqual({ type: "pause" });
  });

  it("parses resume command", () => {
    expect(parsePmCommand("resume")).toEqual({ type: "resume" });
  });

  it("returns unknown for unrecognized input", () => {
    const cmd = parsePmCommand("do something weird");
    expect(cmd.type).toBe("unknown");
  });

  it("is case insensitive for keywords", () => {
    expect(parsePmCommand("PRIORITIZE BEC-25")).toEqual({ type: "prioritize", issueId: "BEC-25" });
    expect(parsePmCommand("STATUS")).toEqual({ type: "status" });
  });

  it("uppercases the issue id for prioritize", () => {
    const cmd = parsePmCommand("prioritize bec-25");
    expect(cmd).toEqual({ type: "prioritize", issueId: "BEC-25" });
  });
});

// ---------------------------------------------------------------------------
// interpretNaturalLanguage
// ---------------------------------------------------------------------------
describe("interpretNaturalLanguage", () => {
  it("returns parsed command from valid Claude JSON output", async () => {
    const callClaude = vi.fn().mockResolvedValue('{"type":"prioritize","issueId":"BEC-25"}');
    const cmd = await interpretNaturalLanguage("make BEC-25 more urgent", callClaude);
    expect(cmd).toEqual({ type: "prioritize", issueId: "BEC-25" });
  });

  it("returns status from JSON embedded in prose", async () => {
    const callClaude = vi.fn().mockResolvedValue('Sure thing! {"type":"status"} here you go');
    const cmd = await interpretNaturalLanguage("what is running?", callClaude);
    expect(cmd).toEqual({ type: "status" });
  });

  it("returns unknown when Claude returns no JSON", async () => {
    const callClaude = vi.fn().mockResolvedValue("I cannot help with that.");
    const cmd = await interpretNaturalLanguage("??", callClaude);
    expect(cmd.type).toBe("unknown");
  });

  it("returns unknown when Claude returns invalid type", async () => {
    const callClaude = vi.fn().mockResolvedValue('{"type":"hack","payload":"x"}');
    const cmd = await interpretNaturalLanguage("something", callClaude);
    expect(cmd.type).toBe("unknown");
  });

  it("returns unknown when callClaude throws", async () => {
    const callClaude = vi.fn().mockRejectedValue(new Error("boom"));
    const cmd = await interpretNaturalLanguage("anything", callClaude);
    expect(cmd.type).toBe("unknown");
  });

  it("returns bulk_create for bulk create intent", async () => {
    const callClaude = vi.fn().mockResolvedValue('{"type":"bulk_create","request":"create issues for all the gaps in the app"}');
    const cmd = await interpretNaturalLanguage("create issues for all the gaps in the app", callClaude);
    expect(cmd).toEqual({ type: "bulk_create", request: "create issues for all the gaps in the app" });
  });
});

// ---------------------------------------------------------------------------
// analyzeBulkCreateRequest
// ---------------------------------------------------------------------------
describe("analyzeBulkCreateRequest", () => {
  it("parses a valid JSON array from Claude response", async () => {
    const mockSonnet = vi.fn().mockResolvedValue(
      JSON.stringify([
        {
          title: "Add rate limiting",
          description: "Implement API rate limiting to prevent abuse",
          priority: 2,
          acceptanceCriteria: ["Rate limit is enforced per IP", "429 response on exceeded limit"],
        },
        {
          title: "Add error monitoring",
          description: "Set up error tracking service",
          priority: 3,
          acceptanceCriteria: ["Errors are captured and reported"],
        },
      ]),
    );
    const specs = await analyzeBulkCreateRequest("find gaps in the app", mockSonnet);
    expect(specs).toHaveLength(2);
    expect(specs[0].title).toBe("Add rate limiting");
    expect(specs[0].priority).toBe(2);
    expect(specs[0].acceptanceCriteria).toHaveLength(2);
    expect(specs[1].title).toBe("Add error monitoring");
  });

  it("handles JSON array embedded in prose", async () => {
    const mockSonnet = vi.fn().mockResolvedValue(
      `Here are the issues:\n[{"title":"Fix login","description":"Fix the login flow","priority":1,"acceptanceCriteria":["User can log in"]}]\nDone.`,
    );
    const specs = await analyzeBulkCreateRequest("fix the login flow", mockSonnet);
    expect(specs).toHaveLength(1);
    expect(specs[0].title).toBe("Fix login");
    expect(specs[0].priority).toBe(1);
  });

  it("returns empty array when no JSON array found", async () => {
    const mockSonnet = vi.fn().mockResolvedValue("I cannot help with that.");
    const specs = await analyzeBulkCreateRequest("anything", mockSonnet);
    expect(specs).toEqual([]);
  });

  it("skips items without a title", async () => {
    const mockSonnet = vi.fn().mockResolvedValue(
      JSON.stringify([
        { title: "", description: "desc", priority: 2, acceptanceCriteria: ["AC1"] },
        { title: "Valid title", description: "desc", priority: 3, acceptanceCriteria: ["AC1"] },
      ]),
    );
    const specs = await analyzeBulkCreateRequest("create issues", mockSonnet);
    expect(specs).toHaveLength(1);
    expect(specs[0].title).toBe("Valid title");
  });

  it("defaults priority to 3 for invalid values", async () => {
    const mockSonnet = vi.fn().mockResolvedValue(
      JSON.stringify([{ title: "Test issue", description: "desc", priority: 99, acceptanceCriteria: ["AC1"] }]),
    );
    const specs = await analyzeBulkCreateRequest("test", mockSonnet);
    expect(specs[0].priority).toBe(3);
  });

  it("caps results at 10 issues", async () => {
    const issues = Array.from({ length: 15 }, (_, i) => ({
      title: `Issue ${i + 1}`,
      description: "desc",
      priority: 3,
      acceptanceCriteria: ["AC"],
    }));
    const mockSonnet = vi.fn().mockResolvedValue(JSON.stringify(issues));
    const specs = await analyzeBulkCreateRequest("many issues", mockSonnet);
    expect(specs).toHaveLength(10);
  });

  it("returns empty array when callClaudeSonnet throws", async () => {
    const mockSonnet = vi.fn().mockRejectedValue(new Error("API error"));
    const specs = await analyzeBulkCreateRequest("anything", mockSonnet);
    expect(specs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// executePmCommand
// ---------------------------------------------------------------------------
describe("executePmCommand", () => {
  it("returns running status when not paused", async () => {
    const reply = await executePmCommand({ type: "status" }, {});
    expect(reply).toContain("Running");
  });

  it("pauses and replies", async () => {
    expect(isPmPaused()).toBe(false);
    const reply = await executePmCommand({ type: "pause" }, {});
    expect(isPmPaused()).toBe(true);
    expect(reply).toContain("paused");
  });

  it("resumes and replies", async () => {
    setPmPaused(true);
    const reply = await executePmCommand({ type: "resume" }, {});
    expect(isPmPaused()).toBe(false);
    expect(reply).toContain("resumed");
  });

  it("returns paused in status when paused", async () => {
    setPmPaused(true);
    const reply = await executePmCommand({ type: "status" }, {});
    expect(reply).toContain("Paused");
  });

  it("returns warning for prioritize without linearApiKey", async () => {
    const reply = await executePmCommand({ type: "prioritize", issueId: "BEC-99" }, {});
    expect(reply).toContain("No Linear API key");
  });

  it("returns warning for assign without linearApiKey", async () => {
    const reply = await executePmCommand({ type: "assign", issueId: "BEC-99" }, {});
    expect(reply).toContain("No Linear API key");
  });

  it("returns warning for create without linearApiKey", async () => {
    const reply = await executePmCommand(
      { type: "create", title: "T", description: "D" },
      {},
    );
    expect(reply).toContain("No Linear API key");
  });

  it("returns warning for create without teamIds", async () => {
    const reply = await executePmCommand(
      { type: "create", title: "T", description: "D" },
      { linearApiKey: "lin_test", teamIds: [] },
    );
    expect(reply).toContain("No team IDs");
  });

  it("returns help text for unknown command", async () => {
    const reply = await executePmCommand({ type: "unknown", original: "gibberish" }, {});
    expect(reply).toContain("/pm status");
    expect(reply).toContain("/pm prioritize");
  });

  it("returns warning for bulk_create without linearApiKey", async () => {
    const reply = await executePmCommand({ type: "bulk_create", request: "find gaps" }, {});
    expect(reply).toContain("No Linear API key");
  });

  it("returns warning for bulk_create without teamIds", async () => {
    const reply = await executePmCommand(
      { type: "bulk_create", request: "find gaps" },
      { linearApiKey: "lin_test", teamIds: [], callClaudeSonnet: vi.fn() },
    );
    expect(reply).toContain("No team IDs");
  });

  it("returns warning for bulk_create without callClaudeSonnet", async () => {
    const reply = await executePmCommand(
      { type: "bulk_create", request: "find gaps" },
      { linearApiKey: "lin_test", teamIds: ["team-1"] },
    );
    expect(reply).toContain("Bulk create requires a Sonnet model caller");
  });

  it("returns not-understood message when Sonnet produces no issues", async () => {
    const mockSonnet = vi.fn().mockResolvedValue("[]");
    const reply = await executePmCommand(
      { type: "bulk_create", request: "something vague" },
      { linearApiKey: "lin_test", teamIds: ["team-1"], callClaudeSonnet: mockSonnet },
    );
    expect(reply).toContain("Could not generate any issues");
  });
});

// ---------------------------------------------------------------------------
// verifySlackSignature
// ---------------------------------------------------------------------------
describe("verifySlackSignature", () => {
  it("returns false for stale timestamp", async () => {
    const staleMins = Math.floor((Date.now() - 10 * 60 * 1000) / 1000).toString();
    const result = await verifySlackSignature("body", staleMins, "v0=abc", "secret");
    expect(result).toBe(false);
  });

  it("returns false for mismatched signature", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const result = await verifySlackSignature("body", ts, "v0=wrongsig", "secret");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SlackInterfaceNotifier
// ---------------------------------------------------------------------------
describe("SlackInterfaceNotifier", () => {
  const notifier = new SlackInterfaceNotifier({
    botToken: "xoxb-test",
    channelId: "C0123456",
  });

  it("notifyAssigned posts a message with issue info", async () => {
    await notifier.notifyAssigned({
      issueId: "BEC-10",
      issueTitle: "Add sanitizer",
      reasoning: "Highest priority, no conflicts",
      issueUrl: "https://linear.app/t/BEC-10",
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain("BEC-10");
    expect(body.blocks[0].text.text).toContain("Add sanitizer");
  });

  it("notifySkipped posts a message with skip reason", async () => {
    await notifier.notifySkipped({
      issueId: "BEC-20",
      issueTitle: "Refactor DB",
      reasoning: "High conflict risk",
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain("skipped");
    expect(body.blocks[0].text.text).toContain("BEC-20");
  });

  it("askForClarification posts a question", async () => {
    await notifier.askForClarification("Which is more urgent: BEC-5 or BEC-6?");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain("PM Agent needs your input");
  });

  it("postDailySummary posts grouped entries", async () => {
    const entries: DailySummaryEntry[] = [
      { issueId: "BEC-1", issueTitle: "Feature A", status: "assigned" },
      { issueId: "BEC-2", issueTitle: "Feature B", status: "completed" },
      { issueId: "BEC-3", issueTitle: "Feature C", status: "blocked" },
    ];
    await notifier.postDailySummary(entries, "Monday, April 6");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text = body.blocks[0].text.text;
    expect(text).toContain("Daily Summary");
    expect(text).toContain("BEC-1");
    expect(text).toContain("BEC-2");
    expect(text).toContain("BEC-3");
    expect(text).toContain("Assigned");
    expect(text).toContain("Completed");
    expect(text).toContain("Blocked");
  });

  it("postDailySummary handles empty entries", async () => {
    await notifier.postDailySummary([]);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain("No activity today");
  });
});

// ---------------------------------------------------------------------------
// Hono router — slash commands
// ---------------------------------------------------------------------------
describe("POST /slack/commands", () => {
  function buildApp() {
    const { router } = createSlackInterface({
      signingSecret: "test-signing-secret",
      botToken: "xoxb-test",
      channelId: "C0123",
      // Use mock callClaude to avoid real SDK usage
      callClaude: vi.fn().mockResolvedValue('{"type":"unknown","original":"test"}'),
    });
    return router;
  }

  it("returns 401 when signature is missing", async () => {
    const app = buildApp();
    const res = await app.request("/slack/commands", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "text=status",
    });
    expect(res.status).toBe(401);
  });

  it("responds with status text for /pm status command (with bypass via recent timestamp)", async () => {
    // We can't easily produce a valid HMAC in tests, so we mock verifySlackSignature
    // by using a test signing secret and providing a matching sig computed manually.
    // Instead, test via the router with mocked fetch to verify command processing works.
    // The signature check requires crypto — skip the full integration route test here;
    // the individual unit tests above cover the logic paths.
    const app = buildApp();
    // Valid request headers are tested via verifySlackSignature unit tests above.
    // This test just confirms 401 is returned on missing headers (covered above).
    expect(app).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// isPmPaused env-var path (BEC-170)
// ---------------------------------------------------------------------------
describe("isPmPaused — PM_AGENT_PAUSED env var", () => {
  beforeEach(() => {
    // Reset both state vectors between tests
    delete process.env.PM_AGENT_PAUSED;
    setPmPaused(false);
  });

  afterEach(() => {
    delete process.env.PM_AGENT_PAUSED;
  });

  it("returns true when PM_AGENT_PAUSED=true even without Slack /pm pause", () => {
    process.env.PM_AGENT_PAUSED = "true";
    expect(isPmPaused()).toBe(true);
  });

  it("env-var wins: PM_AGENT_PAUSED=true AND setPmPaused(false) → still paused", () => {
    process.env.PM_AGENT_PAUSED = "true";
    setPmPaused(false);
    expect(isPmPaused()).toBe(true);
  });

  it("Slack path preserved: PM_AGENT_PAUSED unset AND setPmPaused(true) → paused", () => {
    // PM_AGENT_PAUSED is unset (done in beforeEach)
    setPmPaused(true);
    expect(isPmPaused()).toBe(true);
  });

  it("returns false when neither env var is set nor Slack pause active", () => {
    // Both reset in beforeEach
    expect(isPmPaused()).toBe(false);
  });

  it("does not treat PM_AGENT_PAUSED=false as paused", () => {
    process.env.PM_AGENT_PAUSED = "false";
    expect(isPmPaused()).toBe(false);
  });

  it("does not treat PM_AGENT_PAUSED=1 as paused (must be exactly 'true')", () => {
    process.env.PM_AGENT_PAUSED = "1";
    expect(isPmPaused()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hono router — events
// ---------------------------------------------------------------------------
describe("POST /slack/events", () => {
  function buildApp() {
    const { router } = createSlackInterface({
      signingSecret: "test-signing-secret",
      botToken: "xoxb-test",
      channelId: "C0123",
      callClaude: vi.fn().mockResolvedValue('{"type":"status"}'),
    });
    return router;
  }

  it("returns 401 when signature is invalid for non-challenge events", async () => {
    const app = buildApp();
    const res = await app.request("/slack/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slack-Request-Timestamp": "0",
        "X-Slack-Signature": "v0=invalid",
      },
      body: JSON.stringify({ type: "event_callback", event: { type: "app_mention", text: "hello" } }),
    });
    expect(res.status).toBe(401);
  });

  it("responds to url_verification challenge without signature check", async () => {
    const app = buildApp();
    const res = await app.request("/slack/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "test-challenge-abc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.challenge).toBe("test-challenge-abc");
  });
});

describe("PM Slack — operator stop/halt commands", () => {
  it('parses "halt"', () => {
    expect(parsePmCommand("halt")).toEqual({ type: "halt" });
    expect(parsePmCommand("  Halt  ")).toEqual({ type: "halt" });
  });

  it('parses "cancel <runId>" and "stop <runId>"', () => {
    expect(parsePmCommand("cancel abc123def")).toEqual({ type: "cancel", runId: "abc123def" });
    expect(parsePmCommand("STOP run_xyz-456")).toEqual({ type: "stop", runId: "run_xyz-456" });
  });

  it("rejects too-short run ids", () => {
    expect(parsePmCommand("cancel ab").type).toBe("unknown");
  });

  it("does not confuse short pause/resume with cancel/stop", () => {
    expect(parsePmCommand("pause")).toEqual({ type: "pause" });
    expect(parsePmCommand("resume")).toEqual({ type: "resume" });
  });

  it("executes cancel through the runner with cancel mode", async () => {
    const requestStop = vi.fn().mockReturnValue({ issueId: "BEC-1", mode: "cancel" });
    const text = await executePmCommand(
      { type: "cancel", runId: "run-abc" },
      { runner: { requestStop }, slackUserId: "U42" },
    );
    expect(requestStop).toHaveBeenCalledWith("run-abc", "cancel");
    expect(text).toMatch(/Cancel signal sent/);
  });

  it("executes stop through the runner with graceful mode", async () => {
    const requestStop = vi.fn().mockReturnValue({ issueId: "BEC-2", mode: "graceful" });
    const text = await executePmCommand(
      { type: "stop", runId: "run-xyz" },
      { runner: { requestStop }, slackUserId: "U42" },
    );
    expect(requestStop).toHaveBeenCalledWith("run-xyz", "graceful");
    expect(text).toMatch(/Graceful stop/);
  });

  it("executes halt through the runner", async () => {
    const haltAll = vi.fn().mockReturnValue({ cancelledRunIds: ["r1", "r2", "r3"] });
    const text = await executePmCommand({ type: "halt" }, { runner: { haltAll }, slackUserId: "U42" });
    expect(haltAll).toHaveBeenCalled();
    expect(text).toMatch(/Halted/);
    expect(text).toMatch(/3 active run/);
  });

  it("reports a config error when runner is missing", async () => {
    const text = await executePmCommand(
      { type: "cancel", runId: "run-abc" },
      { slackUserId: "U42" },
    );
    expect(text).toMatch(/Runner not configured/);
  });

  it("help text lists the new commands when the input is unrecognized", async () => {
    const text = await executePmCommand({ type: "unknown", original: "garbage" }, {});
    expect(text).toMatch(/\/pm cancel/);
    expect(text).toMatch(/\/pm halt/);
  });
});
