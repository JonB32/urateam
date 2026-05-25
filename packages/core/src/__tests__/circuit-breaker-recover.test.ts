import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb, type AnyDb } from "../db/client.js";
import { circuitBreakerState } from "../db/schema.js";
import { recoverCircuitBreaker } from "../pm/actions/recover-circuit-breaker.js";

function fakeLinearClient(currentLabels: string[]) {
  return {
    issue: vi.fn().mockResolvedValue({
      id: "issue-id",
      labels: vi.fn().mockResolvedValue({
        nodes: currentLabels.map((name, i) => ({ id: `lbl-${i}`, name })),
      }),
    }),
    updateIssue: vi.fn().mockResolvedValue({}),
  };
}

describe("recoverCircuitBreaker", () => {
  let db: AnyDb;
  beforeEach(async () => {
    db = await createDb({ connectionString: ":memory:" });
  });

  it("no-ops when no state row exists (human-added needs-design preserved)", async () => {
    const client = fakeLinearClient(["needs-design"]);
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("deletes the state row and removes needs-design label when row exists", async () => {
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 1,
    });
    const client = fakeLinearClient(["bug", "needs-design"]);
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });

    const rows = await db.select().from(circuitBreakerState);
    expect(rows).toHaveLength(0);
    expect(client.updateIssue).toHaveBeenCalledOnce();
    const [, payload] = client.updateIssue.mock.calls[0];
    expect(payload.labelIds).toEqual(["lbl-0"]); // only "bug" survives, needs-design dropped
  });

  it("is idempotent on re-invocation", async () => {
    await db.insert(circuitBreakerState).values({
      issueId: "BEC-1",
      escalatedAt: new Date(),
      probeAttempts: 1,
    });
    const client = fakeLinearClient(["needs-design"]);
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });
    await recoverCircuitBreaker({ db, issueId: "BEC-1", linearClient: client as any });
    expect(client.updateIssue).toHaveBeenCalledTimes(1);
  });
});
