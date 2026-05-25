import { describe, it, expect } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";
import {
  persistDecisionArtifact,
  getLatestDecisionArtifact,
} from "../db/decisions-store.js";
import type { DecisionArtifact } from "../types.js";

const baseRun = (id: string) => ({
  id,
  issueId: "BEC-X",
  issueTitle: "test",
  repoUrl: "https://example.com/repo",
  pipelineKey: "auto-implement",
  status: "queued",
  startedAt: new Date(),
});

describe("decisions-store (BEC-227 Phase 4)", () => {
  it("persistDecisionArtifact writes a row that getLatestDecisionArtifact returns", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r1") as any);
    const artifact: DecisionArtifact = {
      decisions: [{ choice: "x", reason: "y", alternativesConsidered: [] }],
      leftUnhandled: [],
      keyFiles: ["a.ts"],
    };
    await persistDecisionArtifact(db, {
      pipelineRunId: "r1",
      iteration: 0,
      stage: "implement",
      payload: artifact,
    });
    const got = await getLatestDecisionArtifact(db, "r1");
    expect(got).not.toBeNull();
    expect(got!.payload.decisions[0]!.choice).toBe("x");
    expect(got!.iteration).toBe(0);
    expect(got!.stage).toBe("implement");
  });

  it("getLatestDecisionArtifact returns the highest-iteration row when multiple exist", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r2") as any);
    for (const i of [0, 2, 1]) {
      await persistDecisionArtifact(db, {
        pipelineRunId: "r2",
        iteration: i,
        stage: "implement",
        payload: { decisions: [{ choice: `c${i}`, reason: "r", alternativesConsidered: [] }], leftUnhandled: [], keyFiles: [] },
      });
    }
    const got = await getLatestDecisionArtifact(db, "r2");
    expect(got!.iteration).toBe(2);
    expect(got!.payload.decisions[0]!.choice).toBe("c2");
  });

  it("getLatestDecisionArtifact returns null when no rows exist for the run", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r3") as any);
    const got = await getLatestDecisionArtifact(db, "r3");
    expect(got).toBeNull();
  });

  it("persistDecisionArtifact swallows malformed payloads by stringifying as-is and never throws", async () => {
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    await db.insert(pipelineRuns).values(baseRun("r4") as any);
    // Cast as any: the persist helper is the boundary; we ensure it doesn't crash even with junk.
    await expect(
      persistDecisionArtifact(db, {
        pipelineRunId: "r4",
        iteration: 0,
        stage: "implement",
        payload: { decisions: "not-an-array" } as any,
      }),
    ).resolves.toBeUndefined();
  });
});
