import { describe, it, expect } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";

describe("agent_session_id migration (BEC-227)", () => {
  it("pipelineRuns has agentSessionId column on a fresh SQLite db", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "test-run-1",
      issueId: "BEC-227",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
      agentSessionId: "session-uuid-abc",
    });
    const rows = await db.select().from(pipelineRuns);
    expect(rows[0]!.agentSessionId).toBe("session-uuid-abc");
  });

  it("agentSessionId is nullable (legacy rows)", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    await db.insert(pipelineRuns).values({
      id: "legacy-run-1",
      issueId: "BEC-227",
      issueTitle: "legacy",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
    });
    const rows = await db.select().from(pipelineRuns);
    expect(rows[0]!.agentSessionId).toBeNull();
  });
});
