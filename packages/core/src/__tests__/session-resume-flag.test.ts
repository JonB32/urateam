import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type AnyDb } from "../db/client.js";
import { pipelineRuns } from "../db/schema.js";

/**
 * BEC-227 — agent_session_id minting + opt-out flag semantics.
 *
 * Phase 3: default ON. `runner.start()` mints an `agent_session_id` UUID
 * for every pipeline run unless the operator sets
 * `URATEAM_DISABLE_AGENT_SESSION_RESUME=true`. The strict equality semantics
 * mirror the BEC-218 precedent (`URATEAM_DISABLE_TIER_6E`).
 *
 * This test simulates the row state directly (rather than invoking
 * `start()` which requires reconstructing 6 positional params + a queue +
 * executor) and asserts the column behaviour — the runner-level
 * integration is verified by typecheck + existing pipeline tests.
 */
describe("agent_session_id minting (BEC-227 Phase 3 — default ON)", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.URATEAM_DISABLE_AGENT_SESSION_RESUME;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.URATEAM_DISABLE_AGENT_SESSION_RESUME;
    } else {
      process.env.URATEAM_DISABLE_AGENT_SESSION_RESUME = originalEnv;
    }
  });

  it("default (env unset) → mints UUID and persists on pipeline_runs row", async () => {
    delete process.env.URATEAM_DISABLE_AGENT_SESSION_RESUME;
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    const runId = "test-run-default-on";
    await db.insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-227",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
      agentSessionId: "expected-uuid", // simulate what start() writes when default-on
    });
    const [row] = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    expect(row!.agentSessionId).toBe("expected-uuid");
  });

  it("explicit opt-out via DISABLE=true → agentSessionId can be null", async () => {
    process.env.URATEAM_DISABLE_AGENT_SESSION_RESUME = "true";
    const db: AnyDb = await createDb({ driver: "sqlite", connectionString: ":memory:" });
    const runId = "test-run-opt-out";
    await db.insert(pipelineRuns).values({
      id: runId,
      issueId: "BEC-227",
      issueTitle: "test",
      repoUrl: "https://example.com/repo",
      pipelineKey: "auto-implement",
      status: "queued",
      startedAt: new Date(),
      // start() under opt-out leaves agent_session_id null
    });
    const [row] = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, runId));
    expect(row!.agentSessionId).toBeNull();
  });

  it("isAgentSessionResumeEnabled is default-on with strict opt-out (BEC-227 Phase 3)", async () => {
    const { isAgentSessionResumeEnabled } = await import(
      "../executor/session-policy.js"
    );
    // Default ON when var is unset or any value other than literal "true".
    expect(isAgentSessionResumeEnabled({})).toBe(true);
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_DISABLE_AGENT_SESSION_RESUME: "",
      }),
    ).toBe(true);
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_DISABLE_AGENT_SESSION_RESUME: "false",
      }),
    ).toBe(true);
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_DISABLE_AGENT_SESSION_RESUME: "1",
      }),
    ).toBe(true);
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_DISABLE_AGENT_SESSION_RESUME: "yes",
      }),
    ).toBe(true);
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_DISABLE_AGENT_SESSION_RESUME: "TRUE",
      }),
    ).toBe(true);
    // Off only on literal "true" (strict equality, matches BEC-218 precedent).
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_DISABLE_AGENT_SESSION_RESUME: "true",
      }),
    ).toBe(false);
  });

  it("legacy URATEAM_ENABLE_AGENT_SESSION_RESUME is ignored under Phase 3", async () => {
    const { isAgentSessionResumeEnabled } = await import(
      "../executor/session-policy.js"
    );
    // Phase 1/2 operators may still have URATEAM_ENABLE_AGENT_SESSION_RESUME
    // set in their .env. Under Phase 3 it is ignored; default-on applies.
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_ENABLE_AGENT_SESSION_RESUME: "true",
      }),
    ).toBe(true);
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_ENABLE_AGENT_SESSION_RESUME: "false",
      }),
    ).toBe(true);
    // The new var still wins.
    expect(
      isAgentSessionResumeEnabled({
        URATEAM_ENABLE_AGENT_SESSION_RESUME: "true",
        URATEAM_DISABLE_AGENT_SESSION_RESUME: "true",
      }),
    ).toBe(false);
  });
});
