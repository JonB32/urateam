import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { createWebhookHandler } from "../webhook/handler.js";
import type { WebhookHandlerConfig } from "../webhook/handler.js";
import type { PipelineConfig, RepoConfig } from "../types.js";
import { createDb } from "../db/client.js";

// Helper to generate a valid HMAC signature
function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SECRET = "whsec_test_secret";

const pipelineConfig: PipelineConfig = {
  name: "auto-implement",
  stages: ["triage", "implement", "test", "review"],
  retry: { maxAttempts: 1, strategy: "fix-and-retry" },
  review: { requiredApprovals: 1 },
  prStrategy: "draft",
};

const repoConfig: RepoConfig = {
  url: "https://github.com/org/repo",
  defaultBranch: "main",
  testCommand: "npm test",
  buildCommand: "npm run build",
};

function stateChangePayload(stateName: string, labels: string[] = ["auto-implement"]) {
  return {
    action: "update",
    type: "Issue",
    data: {
      id: "issue-uuid-123",
      identifier: "LIN-42",
      title: "Add user search",
      description: "Implement search functionality",
      priority: 2,
      state: { id: "state-uuid", name: stateName },
      teamId: "team-frontend",
      labels: labels.map((name) => ({ name })),
    },
    updatedFrom: { stateId: "old-state-uuid" },
  };
}

function commentPayload() {
  return {
    action: "create",
    type: "Comment",
    data: { id: "comment-123", body: "Added a comment" },
  };
}

// ---------------------------------------------------------------------------
// Mock PipelineRunner
// ---------------------------------------------------------------------------
function createMockRunner() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    isActive: vi.fn().mockReturnValue(false),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function buildConfig(
  runner: ReturnType<typeof createMockRunner>,
  overrides?: Partial<WebhookHandlerConfig>,
): WebhookHandlerConfig {
  return {
    webhookSecret: SECRET,
    runner: runner as any,
    pipelineConfigs: { "auto-implement": pipelineConfig },
    repoConfigs: { "team-frontend": repoConfig },
    ...overrides,
  };
}

async function postWebhook(
  app: ReturnType<typeof createWebhookHandler>,
  body: Record<string, any>,
  secret: string = SECRET,
) {
  const rawBody = JSON.stringify(body);
  const sig = sign(rawBody, secret);
  return app.request("/webhooks/linear", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": sig,
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("createWebhookHandler", () => {
  let runner: ReturnType<typeof createMockRunner>;

  beforeEach(() => {
    vi.restoreAllMocks();
    runner = createMockRunner();
  });

  it("returns 401 for invalid signature", async () => {
    const app = createWebhookHandler(buildConfig(runner));
    const rawBody = JSON.stringify(stateChangePayload("Todo"));
    const res = await app.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Signature": "invalid-sig",
      },
      body: rawBody,
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Invalid signature");
  });

  it("returns 200 for valid signature with state change and dispatches start", async () => {
    const app = createWebhookHandler(buildConfig(runner));
    const res = await postWebhook(app, stateChangePayload("Todo"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.action).toBe("start");
    expect(json.runQueued).toBe(true);
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("returns 200 for comment webhook (ignored)", async () => {
    const app = createWebhookHandler(buildConfig(runner));
    const res = await postWebhook(app, commentPayload());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("returns 200 for unknown state (ignored)", async () => {
    const app = createWebhookHandler(buildConfig(runner));
    const res = await postWebhook(app, stateChangePayload("In Progress"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("deduplicates same webhook within 30s window", async () => {
    const app = createWebhookHandler(buildConfig(runner));
    const payload = stateChangePayload("Todo");

    // First request should dispatch
    const res1 = await postWebhook(app, payload);
    const json1 = await res1.json();
    expect(json1.action).toBe("start");
    expect(runner.start).toHaveBeenCalledTimes(1);

    // Second identical request should be deduplicated
    const res2 = await postWebhook(app, payload);
    const json2 = await res2.json();
    expect(json2.deduplicated).toBe(true);
    expect(runner.start).toHaveBeenCalledTimes(1); // Still 1
  });

  it("returns message when no pipeline matches labels", async () => {
    const app = createWebhookHandler(buildConfig(runner));
    const res = await postWebhook(app, stateChangePayload("Todo", ["unknown-label"]));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.message).toBe("No pipeline config for labels");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("returns 422 when no repo mapping found", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const config = buildConfig(runner, {
      repoConfigs: {}, // No repo configs
    });
    const app = createWebhookHandler(config);
    const res = await postWebhook(app, stateChangePayload("Todo"));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("No repo mapping for team/project");
    expect(json.teamId).toBe("team-frontend");
    expect(runner.start).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("uses per-team triggerMap from repoConfig when present", async () => {
    // Team uses "Ready for Dev" instead of default "Todo"
    const customRepoConfig = {
      ...repoConfig,
      triggerMap: { start: "Ready for Dev", resume: "Approved", pause: "On Hold", abort: "Won't Fix" },
    };
    const app = createWebhookHandler(
      buildConfig(runner, { repoConfigs: { "team-frontend": customRepoConfig } }),
    );

    // Default "Todo" state should NOT trigger start with custom map
    const resTodo = await postWebhook(app, stateChangePayload("Todo"));
    const jsonTodo = await resTodo.json();
    expect(jsonTodo.action).toBeUndefined();
    expect(runner.start).not.toHaveBeenCalled();

    // Custom "Ready for Dev" state should trigger start
    const resCustom = await postWebhook(app, stateChangePayload("Ready for Dev"));
    const jsonCustom = await resCustom.json();
    expect(jsonCustom.action).toBe("start");
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it("falls back to global triggerMap when repoConfig has none", async () => {
    // Global override: use "Backlog" as start state
    const app = createWebhookHandler(
      buildConfig(runner, {
        triggerMap: { start: "Backlog", resume: "Approved", pause: "Blocked", abort: "Canceled" },
      }),
    );

    // Default "Todo" should NOT trigger start
    const resTodo = await postWebhook(app, stateChangePayload("Todo"));
    const jsonTodo = await resTodo.json();
    expect(jsonTodo.action).toBeUndefined();

    // Global "Backlog" should trigger start
    const resBacklog = await postWebhook(app, stateChangePayload("Backlog"));
    const jsonBacklog = await resBacklog.json();
    expect(jsonBacklog.action).toBe("start");
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // DB-backed dedup: restart-survival and multi-instance scenarios
  // -------------------------------------------------------------------------

  describe("DB-backed dedup", () => {
    it("deduplicates within the same handler instance using DB", async () => {
      const db = await createDb({ connectionString: ":memory:" });
      const app = createWebhookHandler(buildConfig(runner, { db }));
      const payload = stateChangePayload("Todo");

      const res1 = await postWebhook(app, payload);
      const json1 = await res1.json();
      expect(json1.action).toBe("start");
      expect(runner.start).toHaveBeenCalledTimes(1);

      const res2 = await postWebhook(app, payload);
      const json2 = await res2.json();
      expect(json2.deduplicated).toBe(true);
      expect(runner.start).toHaveBeenCalledTimes(1);
    });

    it("survives restart — second handler instance sees dedup state from DB", async () => {
      // Use a shared in-memory SQLite DB (same connection shared across both handlers)
      const db = await createDb({ connectionString: ":memory:" });

      // First "process": handler 1 receives the webhook and stores dedup entry in DB
      const app1 = createWebhookHandler(buildConfig(runner, { db }));
      const payload = stateChangePayload("Todo");

      const res1 = await postWebhook(app1, payload);
      const json1 = await res1.json();
      expect(json1.action).toBe("start");
      expect(runner.start).toHaveBeenCalledTimes(1);

      // Simulate "restart" — create a brand-new handler (new in-memory DedupSet would be empty,
      // but DB-backed dedup still has the entry from the first handler)
      const runner2 = createMockRunner();
      const app2 = createWebhookHandler(buildConfig(runner2, { db }));

      const res2 = await postWebhook(app2, payload);
      const json2 = await res2.json();
      expect(json2.deduplicated).toBe(true);
      expect(runner2.start).not.toHaveBeenCalled();
    });

    it("provides correct dedup across two concurrent instances sharing the same DB", async () => {
      // Both instances share the same DB connection (simulates multi-instance with shared Postgres)
      const db = await createDb({ connectionString: ":memory:" });
      const runner2 = createMockRunner();

      const app1 = createWebhookHandler(buildConfig(runner, { db }));
      const app2 = createWebhookHandler(buildConfig(runner2, { db }));
      const payload = stateChangePayload("Todo");

      // Instance 1 processes the webhook
      const res1 = await postWebhook(app1, payload);
      const json1 = await res1.json();
      expect(json1.action).toBe("start");
      expect(runner.start).toHaveBeenCalledTimes(1);

      // Instance 2 receives the same webhook — should be deduplicated via shared DB
      const res2 = await postWebhook(app2, payload);
      const json2 = await res2.json();
      expect(json2.deduplicated).toBe(true);
      expect(runner2.start).not.toHaveBeenCalled();
    });

    it("falls back to in-memory dedup when no DB is configured", async () => {
      // No db option — uses MemoryDedupBackend (existing behavior preserved)
      const app = createWebhookHandler(buildConfig(runner));
      const payload = stateChangePayload("Todo");

      const res1 = await postWebhook(app, payload);
      const json1 = await res1.json();
      expect(json1.action).toBe("start");

      const res2 = await postWebhook(app, payload);
      const json2 = await res2.json();
      expect(json2.deduplicated).toBe(true);
    });

    it("DB dedup cleanup removes expired entries", async () => {
      const db = await createDb({ connectionString: ":memory:" });
      const app = createWebhookHandler(buildConfig(runner, { db }));
      const payload = stateChangePayload("Todo");

      const res1 = await postWebhook(app, payload);
      const json1 = await res1.json();
      expect(json1.action).toBe("start");
      expect(runner.start).toHaveBeenCalledTimes(1);

      // Within the same 30s window, dedup should still work
      const res2 = await postWebhook(app, payload);
      const json2 = await res2.json();
      expect(json2.deduplicated).toBe(true);
      expect(runner.start).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Spend caps & alerts: webhook 100% budget gate
// ---------------------------------------------------------------------------
describe("webhook handler — 100% budget gate", () => {
  const basePmConfig = {
    enabled: true,
    dailyTokenBudget: 1_000_000,
    slackChannelId: "C_TEST",
    teamIds: ["team-frontend"],
    maxInFlight: 3,
    cronIntervalMs: 1_800_000,
    triageBatchSize: 3,
    stuckIssueRecovery: true,
    stuckIssueTargetState: "Backlog" as const,
    stuckIssueMaxPerTick: 5,
    requirePipelineLabelForPromote: false,
        maxConsecutiveFailures: 3,
  };

  it("refuses to start a pipeline when the configured scope is at 100%", async () => {
    const startSpy = vi.fn().mockResolvedValue(undefined);

    const db = await createDb({ connectionString: ":memory:" });
    const { pipelineRuns } = await import("../db/schema.js");

    // Pre-seed a row dated today that pushes the global scope above the limit.
    await (db as any).insert(pipelineRuns).values({
      id: "seed-blocked",
      issueId: "LIN-41",
      issueTitle: "prior run",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/org/repo",
      status: "running",
      startedAt: new Date(),
      totalInputTokens: 700_000,
      totalOutputTokens: 400_000, // sum = 1.1M > 1M budget → blocked
      linearTeamId: "team-frontend",
    });

    const app = createWebhookHandler({
      webhookSecret: SECRET,
      runner: {
        start: startSpy,
        resume: vi.fn(),
        pause: vi.fn(),
        abort: vi.fn(),
      } as any,
      pipelineConfigs: { "auto-implement": pipelineConfig },
      repoConfigs: { "team-frontend": repoConfig },
      db,
      pmConfig: { ...basePmConfig },
    });

    const body = JSON.stringify(stateChangePayload("Todo"));
    const res = await app.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(body, SECRET),
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({
      ok: true,
      action: "start",
      runQueued: false,
      reason: "budget-exceeded",
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("starts the pipeline normally when the budget is well under 100%", async () => {
    const startSpy = vi.fn().mockResolvedValue(undefined);

    const db = await createDb({ connectionString: ":memory:" });
    const { pipelineRuns } = await import("../db/schema.js");

    // Seed a small amount of spend — well under the 10M budget
    await (db as any).insert(pipelineRuns).values({
      id: "seed-ok",
      issueId: "LIN-40",
      issueTitle: "small run",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/org/repo",
      status: "completed",
      startedAt: new Date(),
      totalInputTokens: 50_000,
      totalOutputTokens: 50_000,
      linearTeamId: "team-frontend",
    });

    const app = createWebhookHandler({
      webhookSecret: SECRET,
      runner: {
        start: startSpy,
        resume: vi.fn(),
        pause: vi.fn(),
        abort: vi.fn(),
      } as any,
      pipelineConfigs: { "auto-implement": pipelineConfig },
      repoConfigs: { "team-frontend": repoConfig },
      db,
      pmConfig: { ...basePmConfig, dailyTokenBudget: 10_000_000 },
    });

    const body = JSON.stringify(stateChangePayload("Todo"));
    const res = await app.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(body, SECRET),
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: true, action: "start", runQueued: true });
    expect(json.reason).not.toBe("budget-exceeded");
  });

  it("starts the pipeline normally when pmConfig is absent (backward compat)", async () => {
    const startSpy = vi.fn().mockResolvedValue(undefined);

    const app = createWebhookHandler({
      webhookSecret: SECRET,
      runner: {
        start: startSpy,
        resume: vi.fn(),
        pause: vi.fn(),
        abort: vi.fn(),
      } as any,
      pipelineConfigs: { "auto-implement": pipelineConfig },
      repoConfigs: { "team-frontend": repoConfig },
      // No db, no pmConfig — gate is inert
    });

    const body = JSON.stringify(stateChangePayload("Todo"));
    const res = await app.request("/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": sign(body, SECRET),
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: true, action: "start", runQueued: true });
    expect(json.reason).not.toBe("budget-exceeded");
  });
});
