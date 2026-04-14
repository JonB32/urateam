import { describe, it, expect, vi } from "vitest";
import { createDb } from "../db/client.js";
import { auditEvents, pmApprovals } from "../db/schema.js";
import { promoteReadyIssues } from "../pm/actions/promote.js";
import { triageNewIssues } from "../pm/actions/triage.js";
import { resolveApprovals } from "../pm/actions/resolve-approvals.js";

async function getAuditRows(db: any) {
  return await db.select().from(auditEvents);
}

describe("pm action audit events", () => {
  it("emits pm.issue_promoted when promote.ts moves issue to Todo", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const linearClient = {
      issues: vi.fn().mockResolvedValue({
        nodes: [
          {
            id: "issue-1",
            identifier: "BEC-101",
            title: "Fix thing",
            description: "desc",
            priority: 1,
            labels: { nodes: [] },
            team: { id: "team-1" },
            url: "https://linear.app/BEC-101",
          },
        ],
      }),
      updateIssue: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
    };

    await promoteReadyIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      slotsAvailable: 1,
      checkConflict: vi.fn().mockResolvedValue({
        overlapRisk: "none",
        likelyFiles: [],
        reasoning: "",
      }),
      stateMap: new Map([["team-1:Todo", "state-todo"]]),
      db: db as any,
    });

    // Give the void-logAuditEvent microtask a chance to flush
    await new Promise((r) => setImmediate(r));

    const rows = await getAuditRows(db);
    const promoted = rows.filter((r: any) => r.eventType === "pm.issue_promoted");
    expect(promoted).toHaveLength(1);
    expect(promoted[0].issueId).toBe("BEC-101");
    const payload = JSON.parse(promoted[0].payload);
    expect(payload.fromState).toBe("Backlog");
    expect(payload.toState).toBe("Todo");
  });

  it("emits pm.triage_classified after Haiku classifies", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    const linearClient = {
      issues: vi.fn().mockResolvedValue({
        nodes: [
          {
            id: "issue-1",
            identifier: "BEC-202",
            title: "Add feature",
            description: "do the thing",
            labels: { nodes: [] },
            team: { id: "team-1" },
          },
        ],
      }),
      issueLabels: vi.fn().mockResolvedValue({
        nodes: [
          { id: "lbl-feature", name: "feature" },
          { id: "lbl-auto", name: "auto-implement" },
        ],
      }),
      updateIssue: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
    };

    const callClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        priority: 2,
        labels: ["feature"],
        complexity: "small",
        rationale: "Standard feature work",
        acceptanceCriteria: ["a1 integration", "a2 behavior"],
      }),
    );

    await triageNewIssues({
      linearClient: linearClient as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: new Map([["team-1:Backlog", "state-backlog"]]),
      db: db as any,
    });

    await new Promise((r) => setImmediate(r));

    const rows = await getAuditRows(db);
    const triaged = rows.filter((r: any) => r.eventType === "pm.triage_classified");
    expect(triaged).toHaveLength(1);
    expect(triaged[0].issueId).toBe("BEC-202");
    const payload = JSON.parse(triaged[0].payload);
    expect(payload.label).toBe("auto-implement");
    expect(payload.rationale).toBe("Standard feature work");
  });

  it("emits pm.issue_deprioritized after approval resolves", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    // Insert a pending approval row
    await (db as any).insert(pmApprovals).values({
      id: "appr-dep-1",
      issueId: "BEC-301",
      action: "deprioritize",
      reason: "stale",
      slackMessageTs: "ts-dep",
      status: "pending",
    });

    const linearClient = {
      searchIssues: vi.fn().mockResolvedValue({ nodes: [{ id: "linear-id-301" }] }),
      updateIssue: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
    };
    const slackNotifier = {
      checkApprovalReactions: vi.fn().mockResolvedValue("approved"),
      postApprovalExpired: vi.fn().mockResolvedValue(undefined),
    };

    await resolveApprovals({
      linearClient: linearClient as any,
      slackNotifier: slackNotifier as any,
      db: db as any,
      teamIds: ["team-1"],
      stateMap: new Map([
        ["team-1:Icebox", "state-icebox"],
        ["team-1:Canceled", "state-canceled"],
      ]),
    });

    await new Promise((r) => setImmediate(r));

    const rows = await getAuditRows(db);
    const dep = rows.filter((r: any) => r.eventType === "pm.issue_deprioritized");
    expect(dep).toHaveLength(1);
    expect(dep[0].issueId).toBe("BEC-301");
    const payload = JSON.parse(dep[0].payload);
    expect(payload.approvalId).toBe("appr-dep-1");
  });

  it("emits pm.issue_cancelled after approval resolves", async () => {
    const db = await createDb({ connectionString: ":memory:" });

    await (db as any).insert(pmApprovals).values({
      id: "appr-can-1",
      issueId: "BEC-401",
      action: "cancel",
      reason: "abandoned 35 days",
      slackMessageTs: "ts-can",
      status: "pending",
    });

    const linearClient = {
      searchIssues: vi.fn().mockResolvedValue({ nodes: [{ id: "linear-id-401" }] }),
      updateIssue: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
    };
    const slackNotifier = {
      checkApprovalReactions: vi.fn().mockResolvedValue("approved"),
      postApprovalExpired: vi.fn().mockResolvedValue(undefined),
    };

    await resolveApprovals({
      linearClient: linearClient as any,
      slackNotifier: slackNotifier as any,
      db: db as any,
      teamIds: ["team-1"],
      stateMap: new Map([
        ["team-1:Icebox", "state-icebox"],
        ["team-1:Canceled", "state-canceled"],
      ]),
    });

    await new Promise((r) => setImmediate(r));

    const rows = await getAuditRows(db);
    const canc = rows.filter((r: any) => r.eventType === "pm.issue_cancelled");
    expect(canc).toHaveLength(1);
    expect(canc[0].issueId).toBe("BEC-401");
    const payload = JSON.parse(canc[0].payload);
    expect(payload.approvalId).toBe("appr-can-1");
    expect(payload.reason).toBe("abandoned 35 days");
  });
});
