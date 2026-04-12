import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, pipelineRuns, stageRuns, agentLogs } from "../db/index.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-test-${id}.sqlite`;
}

describe("database", () => {
  const paths: string[] = [];

  async function makeDb() {
    const path = tmpDbPath();
    paths.push(path);
    return createDb({ driver: "sqlite", connectionString: path });
  }

  afterEach(() => {
    for (const p of paths) {
      try {
        unlinkSync(p);
        unlinkSync(p + "-wal");
        unlinkSync(p + "-shm");
      } catch {
        // ignore
      }
    }
    paths.length = 0;
  });

  it("inserts and queries a pipeline_run", async () => {
    const db = await makeDb() as any;
    const now = new Date();

    await db.insert(pipelineRuns).values({
      id: "pr-1",
      issueId: "ISSUE-1",
      issueTitle: "Fix login bug",
      pipelineKey: "default",
      repoUrl: "https://github.com/org/repo",
      status: "running",
      startedAt: now,
    });

    const rows = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, "pr-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].issueId).toBe("ISSUE-1");
    expect(rows[0].issueTitle).toBe("Fix login bug");
    expect(rows[0].status).toBe("running");
    expect(rows[0].totalInputTokens).toBe(0);
    expect(rows[0].totalOutputTokens).toBe(0);
  });

  it("inserts stage_runs linked to a pipeline_run", async () => {
    const db = await makeDb() as any;
    const now = new Date();

    await db.insert(pipelineRuns).values({
      id: "pr-2",
      issueId: "ISSUE-2",
      issueTitle: "Add feature",
      pipelineKey: "default",
      repoUrl: "https://github.com/org/repo",
      status: "running",
      startedAt: now,
    });

    await db.insert(stageRuns).values({
      id: "sr-1",
      pipelineRunId: "pr-2",
      stage: "triage",
      status: "completed",
      startedAt: now,
      completedAt: now,
      inputTokens: 1000,
      outputTokens: 500,
      turns: 3,
    });

    await db.insert(stageRuns).values({
      id: "sr-2",
      pipelineRunId: "pr-2",
      stage: "implement",
      status: "running",
      startedAt: now,
    });

    const rows = await db
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.pipelineRunId, "pr-2"));

    expect(rows).toHaveLength(2);
    expect(rows[0].stage).toBe("triage");
    expect(rows[0].inputTokens).toBe(1000);
    expect(rows[1].stage).toBe("implement");
    expect(rows[1].turns).toBe(0);
  });

  it("inserts agent_logs linked to a stage_run", async () => {
    const db = await makeDb() as any;
    const now = new Date();

    await db.insert(pipelineRuns).values({
      id: "pr-3",
      issueId: "ISSUE-3",
      issueTitle: "Refactor module",
      pipelineKey: "default",
      repoUrl: "https://github.com/org/repo",
      status: "running",
      startedAt: now,
    });

    await db.insert(stageRuns).values({
      id: "sr-3",
      pipelineRunId: "pr-3",
      stage: "implement",
      status: "running",
      startedAt: now,
    });

    await db.insert(agentLogs).values([
      {
        id: "log-1",
        stageRunId: "sr-3",
        timestamp: now,
        type: "tool_call",
        content: JSON.stringify({ tool: "bash", input: "ls" }),
      },
      {
        id: "log-2",
        stageRunId: "sr-3",
        timestamp: now,
        type: "message",
        content: "Listing directory contents",
      },
    ]);

    const rows = await db
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.stageRunId, "sr-3"));

    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("tool_call");
    expect(rows[1].type).toBe("message");
    expect(JSON.parse(rows[0].content)).toEqual({ tool: "bash", input: "ls" });
  });

  it("auto-detects sqlite driver from path", async () => {
    const db = await createDb({ connectionString: ":memory:" });
    expect(db).toBeDefined();
  });

  it("round-trips timestamps through SQLite with second-level precision", async () => {
    const db = await makeDb() as any;

    // Truncate to whole seconds because SQLite stores timestamps as epoch
    // integers (unixepoch), so sub-second precision is lost on the round-trip.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);

    await db.insert(pipelineRuns).values({
      id: "pr-ts",
      issueId: "ISSUE-TS",
      issueTitle: "Timestamp round-trip",
      pipelineKey: "default",
      repoUrl: "https://github.com/org/repo",
      status: "running",
      startedAt: now,
    });

    await db.insert(stageRuns).values({
      id: "sr-ts",
      pipelineRunId: "pr-ts",
      stage: "implement",
      status: "completed",
      startedAt: now,
      completedAt: now,
    });

    await db.insert(agentLogs).values({
      id: "log-ts",
      stageRunId: "sr-ts",
      timestamp: now,
      type: "message",
      content: "timestamp test",
    });

    const [run] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, "pr-ts"));
    const [stage] = await db.select().from(stageRuns).where(eq(stageRuns.id, "sr-ts"));
    const [log] = await db.select().from(agentLogs).where(eq(agentLogs.id, "log-ts"));

    // SQLite returns Date objects (via { mode: "timestamp" }) — verify they
    // round-trip correctly.
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.startedAt!.getTime()).toBe(now.getTime());

    expect(stage.startedAt).toBeInstanceOf(Date);
    expect(stage.startedAt!.getTime()).toBe(now.getTime());
    expect(stage.completedAt).toBeInstanceOf(Date);
    expect(stage.completedAt!.getTime()).toBe(now.getTime());

    expect(log.timestamp).toBeInstanceOf(Date);
    expect(log.timestamp!.getTime()).toBe(now.getTime());
  });
});
