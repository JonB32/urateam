import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { reviewModelRuns } from "../../db/schema.js";
import { nanoid } from "nanoid";
import {
  getModelHealthScores,
  flagLowYieldModels,
} from "../../executor/review/model-health.js";

function setupDb() {
  const sqlite = new Database(":memory:");
  // Minimal table — only what the helper queries
  sqlite.exec(`
    CREATE TABLE review_model_runs (
      id TEXT PRIMARY KEY,
      stage_run_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      truncated_files INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER
    );
  `);
  return drizzle(sqlite);
}

describe("getModelHealthScores", () => {
  it("computes output ratio per model from review_model_runs in lookback window", async () => {
    const db = setupDb();
    const stageId = nanoid();
    const now = new Date();
    // Healthy model: 80% output ratio
    for (let i = 0; i < 10; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(), stageRunId: stageId, providerId: "openrouter",
        modelId: "claude-haiku-4-5", status: "completed",
        inputTokens: 2000, outputTokens: 8000, startedAt: now,
      });
    }
    // Bad model: ~1% output ratio
    for (let i = 0; i < 10; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(), stageRunId: stageId, providerId: "openrouter",
        modelId: "gpt-oss-120b:free", status: "completed",
        inputTokens: 27000, outputTokens: 300, startedAt: now,
      });
    }
    const scores = await getModelHealthScores(db as any, { lookbackHours: 168, minRuns: 5 });
    expect(scores.get("claude-haiku-4-5")?.outputRatio).toBeCloseTo(0.8, 1);
    expect(scores.get("gpt-oss-120b:free")?.outputRatio).toBeCloseTo(0.011, 2);
    expect(scores.get("claude-haiku-4-5")?.runs).toBe(10);
    expect(scores.get("gpt-oss-120b:free")?.runs).toBe(10);
  });

  it("excludes failed runs (status != 'completed') from the ratio", async () => {
    const db = setupDb();
    const stageId = nanoid();
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(), stageRunId: stageId, providerId: "openrouter",
        modelId: "model-a", status: "completed",
        inputTokens: 1000, outputTokens: 800, startedAt: now,
      });
      await db.insert(reviewModelRuns).values({
        id: nanoid(), stageRunId: stageId, providerId: "openrouter",
        modelId: "model-a", status: "failed",
        inputTokens: 0, outputTokens: 0, startedAt: now,
      });
    }
    const scores = await getModelHealthScores(db as any, { lookbackHours: 168, minRuns: 5 });
    expect(scores.get("model-a")?.runs).toBe(5);
    expect(scores.get("model-a")?.outputRatio).toBeCloseTo(800 / 1800, 2);
  });

  it("excludes runs older than lookbackHours", async () => {
    const db = setupDb();
    const stageId = nanoid();
    const ancient = new Date(Date.now() - 200 * 3600_000); // 200h ago > 168h lookback
    const recent = new Date();
    for (let i = 0; i < 5; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(), stageRunId: stageId, providerId: "openrouter",
        modelId: "model-a", status: "completed",
        inputTokens: 1000, outputTokens: 100, startedAt: ancient,
      });
    }
    for (let i = 0; i < 5; i++) {
      await db.insert(reviewModelRuns).values({
        id: nanoid(), stageRunId: stageId, providerId: "openrouter",
        modelId: "model-a", status: "completed",
        inputTokens: 1000, outputTokens: 800, startedAt: recent,
      });
    }
    const scores = await getModelHealthScores(db as any, { lookbackHours: 168, minRuns: 5 });
    expect(scores.get("model-a")?.runs).toBe(5);
    // Only recent rows count: 800 / (1000+800) ≈ 0.444
    expect(scores.get("model-a")?.outputRatio).toBeCloseTo(0.444, 2);
  });
});

describe("flagLowYieldModels", () => {
  it("flags models with outputRatio below threshold and runs >= minRuns", () => {
    const scores = new Map([
      ["healthy-model", { runs: 10, outputRatio: 0.5, lastSeen: new Date() }],
      ["bad-model", { runs: 10, outputRatio: 0.01, lastSeen: new Date() }],
      ["new-model", { runs: 2, outputRatio: 0.01, lastSeen: new Date() }],
    ]);
    const flagged = flagLowYieldModels(
      scores,
      ["healthy-model", "bad-model", "new-model"],
      { threshold: 0.05, minRuns: 5 },
    );
    expect(flagged).toEqual(["bad-model"]);
  });

  it("returns empty when no scores exist (fresh install)", () => {
    const flagged = flagLowYieldModels(new Map(), ["any-model"], { threshold: 0.05, minRuns: 5 });
    expect(flagged).toEqual([]);
  });

  it("does not flag models not present in the input list (caller filtered)", () => {
    const scores = new Map([
      ["bad-model", { runs: 10, outputRatio: 0.01, lastSeen: new Date() }],
    ]);
    const flagged = flagLowYieldModels(scores, ["healthy-model"], { threshold: 0.05, minRuns: 5 });
    expect(flagged).toEqual([]);
  });
});
