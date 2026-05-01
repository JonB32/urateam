/**
 * E2E fanout integration test — BEC-134 Task 14
 *
 * Drives `runReviewProviders` end-to-end with:
 *   - Real in-memory SQLite DB (better-sqlite3 + runMigrationsSqlite + Drizzle)
 *     so actual review_model_runs rows are written and queryable
 *   - Mocked OpenRouter HTTP client  (avoids network)
 *   - Mocked agentic deep-review     (avoids Claude SDK)
 *
 * Verifies the four required properties:
 *   1. Both providers (agentic + openrouter) ran
 *   2. review_model_runs rows were persisted for both providers
 *   3. Agentic findings appear in agenticFindings (merge-gate path)
 *   4. Fanout findings do NOT appear in agenticFindings (advisory only)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { runMigrationsSqlite } from "../db/migrator.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Hoist mocks so they are available at module-evaluation time
// ---------------------------------------------------------------------------

const chatCompletionMock = vi.hoisted(() => vi.fn());
const runDeepReviewMock = vi.hoisted(() => vi.fn());

/**
 * Mock the OpenRouter HTTP client — intercepts the single method that
 * OpenRouterFanoutProvider calls, so no real network request is made.
 */
vi.mock("../executor/review/openrouter-client.js", () => ({
  OpenRouterClient: vi.fn().mockImplementation(() => ({
    chatCompletion: chatCompletionMock,
  })),
}));

/**
 * Mock runDeepReview (called inside AgenticDeepReviewProvider) — avoids
 * loading the Claude Agent SDK and any real sub-process invocations.
 * deepFindingsToReviewFindings is the real util; mock only runDeepReview.
 */
vi.mock("../executor/deep-review.js", async (orig) => {
  const real = await orig<typeof import("../executor/deep-review.js")>();
  return {
    ...real,
    runDeepReview: runDeepReviewMock,
  };
});

/**
 * Mock workdir snapshot — OpenRouterFanoutProvider calls this before building
 * the review prompt. Return empty diff/files so prompt building is trivial.
 */
vi.mock("../executor/review/workdir-snapshot.js", () => ({
  collectWorkdirSnapshot: vi.fn().mockResolvedValue({ diff: "", files: [] }),
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("E2E fanout integration (BEC-134 Task 14)", () => {
  let rawDb: InstanceType<typeof Database>;
  let db: ReturnType<typeof drizzleSqlite<typeof schema>>;
  let stageRunId: string;

  beforeEach(() => {
    // Fresh in-memory SQLite — run ALL migrations so review_model_runs exists
    rawDb = new Database(":memory:");
    rawDb.pragma("foreign_keys = ON");
    runMigrationsSqlite(rawDb);
    db = drizzleSqlite(rawDb, { schema });

    // Seed FK chain: pipeline_run → stage_run so review_model_runs can reference it
    const pipelineRunId = "pr-fanout-e2e";
    const now = Math.floor(Date.now() / 1000);
    rawDb
      .prepare(
        "INSERT INTO pipeline_runs (id, issue_id, issue_title, pipeline_key, repo_url, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(pipelineRunId, "FANOUT-1", "Fanout e2e test", "auto-implement", "https://github.com/test/repo.git", "running", now);

    stageRunId = "sr-fanout-e2e";
    rawDb
      .prepare(
        "INSERT INTO stage_runs (id, pipeline_run_id, stage, status, started_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(stageRunId, pipelineRunId, "review", "running", now);

    // Agentic: returns one blocking finding matching DeepReviewFinding shape
    runDeepReviewMock.mockResolvedValue({
      findings: [
        {
          agent: "quality",
          severity: "blocking",
          file: "src/auth.ts",
          line: 42,
          category: "error-handling",
          description: "Null pointer risk in auth.ts",
          fix: "Add a null check before dereferencing",
        },
      ],
      inputTokens: 80,
      outputTokens: 20,
    });

    // OpenRouter fanout: valid { findings: [...] } envelope per parseReviewFindings contract
    const fanoutResponseContent = JSON.stringify({
      findings: [
        {
          severity: "suggestion",
          file: "src/auth.ts",
          line: 10,
          category: "quality",
          description: "Consider extracting a helper function",
          fix: "Extract the repeated logic into a shared helper",
        },
      ],
    });
    chatCompletionMock.mockResolvedValue({
      content: fanoutResponseContent,
      inputTokens: 50,
      outputTokens: 15,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    rawDb.close();
  });

  it("runs both providers, persists review_model_runs rows, and routes findings correctly", async () => {
    const { runReviewProviders } = await import("../pipeline/review-providers-runner.js");

    const handoff = {
      runId: "pr-fanout-e2e",
      issueId: "FANOUT-1",
      stage: "review",
      timestamp: new Date().toISOString(),
      summary: "Implemented auth feature",
      filesChanged: ["src/auth.ts"],
      approach: "Standard implementation",
      context: {
        issueIntent: "Add OAuth login",
        constraints: [],
        assumptions: [],
      },
      tokenBudget: { contextTokensUsed: 100, recommendedMaxTurns: 5 },
    };

    const result = await runReviewProviders(
      {
        runId: "pr-fanout-e2e",
        stageRunId,
        workdir: "/tmp/fanout-e2e-workdir",
        handoff,
        baseRef: "main",
        prNumber: null,
      },
      {
        env: {
          REVIEW_MODELS: "anthropic/claude-3.5-sonnet",
          OPENROUTER_API_KEY: "sk-or-test-key",
        } as NodeJS.ProcessEnv,
        db: db as any,
      },
    );

    // ── 1. Both providers ran ────────────────────────────────────────────────
    expect(runDeepReviewMock, "agentic provider should have run once").toHaveBeenCalledOnce();
    expect(chatCompletionMock, "openrouter provider should have run once").toHaveBeenCalledOnce();

    // ── 2. review_model_runs rows persisted for both providers ───────────────
    const rows = db
      .select()
      .from(schema.reviewModelRuns)
      .where(eq(schema.reviewModelRuns.stageRunId, stageRunId))
      .all();

    expect(rows, "should have one row per provider").toHaveLength(2);

    const providerIds = rows.map((r) => r.providerId).sort();
    expect(providerIds).toEqual(["agentic", "openrouter"]);

    for (const row of rows) {
      expect(row.status).toBe("completed");
    }

    // ── 3. Agentic findings appear in agenticFindings (merge gate) ───────────
    expect(result.agenticFindings).toHaveLength(1);
    expect(result.agenticFindings[0]!.severity).toBe("blocking");
    expect(result.agenticFindings[0]!.description).toContain("Null pointer risk");

    // ── 4. Fanout findings do NOT appear in agenticFindings (advisory only) ──
    const fanoutRuns = result.allRuns.filter((r) => r.providerId !== "agentic");
    expect(fanoutRuns).toHaveLength(1);
    expect(fanoutRuns[0]!.findings).toHaveLength(1);
    expect(fanoutRuns[0]!.findings[0]!.severity).toBe("suggestion");

    // Fanout findings must not leak into the merge-gate findings list
    const agenticDescriptions = result.agenticFindings.map((f) => f.description);
    for (const fanoutRun of fanoutRuns) {
      for (const finding of fanoutRun.findings) {
        expect(agenticDescriptions).not.toContain(finding.description);
      }
    }

    // ── Bonus: token counts accumulated across both providers ────────────────
    expect(result.totalInputTokens).toBe(130);   // 80 agentic + 50 openrouter
    expect(result.totalOutputTokens).toBe(35);   // 20 agentic + 15 openrouter
  });
});
