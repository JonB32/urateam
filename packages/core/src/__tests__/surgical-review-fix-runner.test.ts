import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns, auditEvents } from "../db/schema.js";
import { persistDecisionArtifact } from "../db/decisions-store.js";
import { installTestProLicense, restoreLicense } from "./helpers/license.js";
import type { ReviewFinding } from "../types.js";

describe("runSurgicalReviewFix (BEC-227 Phase 4 / Track B)", () => {
  let runSurgicalReviewFix: any;
  let mockTranscriptExists: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockTranscriptExists = vi.fn();
    vi.resetModules();
    vi.doMock("../executor/session-store.js", () => ({
      transcriptExists: mockTranscriptExists,
      defaultProjectsRoot: () => "/tmp/fake-projects",
    }));
    // Install the audit-log license AFTER resetModules so the patched
    // public-key module survives the reset (the dynamic import inside
    // logAuditEvent uses the freshly-loaded license module).
    await installTestProLicense("enterprise");
    ({ runSurgicalReviewFix } = await import("../pipeline/run-surgical-review-fix.js"));
  });

  afterEach(async () => {
    await restoreLicense();
    vi.doUnmock("../executor/session-store.js");
    vi.resetModules();
  });

  const findings: ReviewFinding[] = [
    {
      severity: "blocking",
      file: "a.ts",
      line: 1,
      category: "correctness",
      description: "fix me",
      fix: "do it",
    },
  ];

  /** Poll auditEvents until the surgical_review_fix row appears (or timeout). */
  async function waitForSurgicalAuditEvent(db: AnyDb): Promise<any> {
    // logAuditEvent is `void`-fired and internally `await import("../license.js")`s
    // — the dynamic ESM import + drizzle insert chain takes an unpredictable
    // number of microtask + macrotask turns. Poll instead of guessing.
    for (let i = 0; i < 50; i++) {
      const rows = await (db as any).select().from(auditEvents);
      const ev = rows.find((e: any) => e.eventType === "pipeline.surgical_review_fix");
      if (ev) return ev;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error("audit event 'pipeline.surgical_review_fix' did not arrive within 50 ticks");
  }

  it("returns path=surgical when session + JSONL + decisions all present", async () => {
    const db: AnyDb = (await createDb({
      driver: "sqlite",
      connectionString: ":memory:",
    })) as AnyDb;
    await (db as any).insert(pipelineRuns).values({
      id: "r1",
      issueId: "BEC-X",
      issueTitle: "t",
      repoUrl: "x",
      pipelineKey: "auto-implement",
      status: "running",
      startedAt: new Date(),
    } as any);
    await persistDecisionArtifact(db, {
      pipelineRunId: "r1",
      iteration: 0,
      stage: "implement",
      payload: {
        decisions: [{ choice: "x", reason: "y", alternativesConsidered: [] }],
        leftUnhandled: [],
        keyFiles: [],
      },
    });
    mockTranscriptExists.mockReturnValue(true);

    const got = await runSurgicalReviewFix({
      db,
      runId: "r1",
      issueId: "BEC-X",
      agentSessionId: "session-abc",
      worktreePath: "/tmp/x",
      blockingFindings: findings,
    });
    expect(got.path).toBe("surgical");
    expect(got.prompt).toMatch(/fix me/);
    expect(got.prompt).toMatch(/prior decisions|previously decided|previously made/i);
    expect(got.decisionPayloadBytes).toBeGreaterThan(0);

    const ev = await waitForSurgicalAuditEvent(db);
    expect(JSON.parse(ev.payload).path).toBe("surgical");
  });

  it("returns path=legacy when transcriptExists is false", async () => {
    const db: AnyDb = (await createDb({
      driver: "sqlite",
      connectionString: ":memory:",
    })) as AnyDb;
    await (db as any).insert(pipelineRuns).values({
      id: "r2",
      issueId: "BEC-Y",
      issueTitle: "t",
      repoUrl: "x",
      pipelineKey: "auto-implement",
      status: "running",
      startedAt: new Date(),
    } as any);
    mockTranscriptExists.mockReturnValue(false);

    const got = await runSurgicalReviewFix({
      db,
      runId: "r2",
      issueId: "BEC-Y",
      agentSessionId: "session-zzz",
      worktreePath: "/tmp/y",
      blockingFindings: findings,
    });
    expect(got.path).toBe("legacy");

    const ev = await waitForSurgicalAuditEvent(db);
    expect(JSON.parse(ev.payload).path).toBe("legacy");
  });

  it("returns path=legacy when agentSessionId is null", async () => {
    const db: AnyDb = (await createDb({
      driver: "sqlite",
      connectionString: ":memory:",
    })) as AnyDb;
    await (db as any).insert(pipelineRuns).values({
      id: "r3",
      issueId: "BEC-Z",
      issueTitle: "t",
      repoUrl: "x",
      pipelineKey: "auto-implement",
      status: "running",
      startedAt: new Date(),
    } as any);
    const got = await runSurgicalReviewFix({
      db,
      runId: "r3",
      issueId: "BEC-Z",
      agentSessionId: null,
      worktreePath: "/tmp/z",
      blockingFindings: findings,
    });
    expect(got.path).toBe("legacy");
  });

  it("returns path=surgical with decisionPayloadBytes=0 when decisions are absent but session+JSONL present", async () => {
    const db: AnyDb = (await createDb({
      driver: "sqlite",
      connectionString: ":memory:",
    })) as AnyDb;
    await (db as any).insert(pipelineRuns).values({
      id: "r4",
      issueId: "BEC-Q",
      issueTitle: "t",
      repoUrl: "x",
      pipelineKey: "auto-implement",
      status: "running",
      startedAt: new Date(),
    } as any);
    mockTranscriptExists.mockReturnValue(true);

    const got = await runSurgicalReviewFix({
      db,
      runId: "r4",
      issueId: "BEC-Q",
      agentSessionId: "session-q",
      worktreePath: "/tmp/q",
      blockingFindings: findings,
    });
    expect(got.path).toBe("surgical");
    expect(got.decisionPayloadBytes).toBe(0);
    expect(got.prompt).toMatch(/fix me/);
    expect(got.prompt).not.toMatch(/prior decisions|previously decided/i);
  });
});
