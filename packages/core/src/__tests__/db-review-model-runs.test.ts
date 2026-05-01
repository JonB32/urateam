import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrationsSqlite } from "../db/migrator.js";

describe("review_model_runs migration (sqlite)", () => {
  it("creates the table with expected columns", () => {
    const db = new Database(":memory:");
    runMigrationsSqlite(db);

    const cols = db
      .prepare("PRAGMA table_info(review_model_runs)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        "completed_at",
        "duration_ms",
        "error_message",
        "id",
        "input_tokens",
        "model_id",
        "output_tokens",
        "provider_id",
        "stage_run_id",
        "started_at",
        "status",
        "truncated_files",
      ].sort(),
    );
  });

  it("creates an index on stage_run_id", () => {
    const db = new Database(":memory:");
    runMigrationsSqlite(db);
    const indexes = db
      .prepare("PRAGMA index_list(review_model_runs)")
      .all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name.includes("stage_run_id"))).toBe(true);
  });

  it("inserts and reads rows", () => {
    const db = new Database(":memory:");
    runMigrationsSqlite(db);

    // Need a stage_run row first (FK)
    db.prepare(
      "INSERT INTO pipeline_runs (id, issue_id, issue_title, pipeline_key, repo_url, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("p1", "i1", "t", "k", "u", "running", Math.floor(Date.now() / 1000));
    db.prepare(
      "INSERT INTO stage_runs (id, pipeline_run_id, stage, status, started_at) VALUES (?, ?, ?, ?, ?)",
    ).run("s1", "p1", "review", "completed", Math.floor(Date.now() / 1000));

    db.prepare(
      "INSERT INTO review_model_runs (id, stage_run_id, provider_id, model_id, status, input_tokens, output_tokens, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("r1", "s1", "openrouter", "anthropic/claude-3.5-sonnet", "completed", 100, 50, 1000);

    const rows = db
      .prepare("SELECT * FROM review_model_runs WHERE stage_run_id = ?")
      .all("s1");
    expect(rows).toHaveLength(1);
  });
});
