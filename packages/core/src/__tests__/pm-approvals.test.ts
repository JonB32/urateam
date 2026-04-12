import { describe, it, expect, vi } from "vitest";
import { deprioritizeStaleIssues } from "../pm/actions/deprioritize.js";
import { cancelAbandonedIssues } from "../pm/actions/cancel.js";
import { resolveApprovals } from "../pm/actions/resolve-approvals.js";

function mockLinearClient(issues: any[]) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: issues }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
    searchIssues: vi.fn().mockResolvedValue({ nodes: [{ id: "resolved-id" }] }),
  };
}

const defaultStateMap = new Map([
  ["team-1:Icebox", "state-icebox"],
  ["team-1:Canceled", "state-canceled"],
]);

function mockApprovalDb() {
  const rows: any[] = [];
  return {
    rows,
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
    insert: () => ({
      values: (v: any) => { rows.push(v); return Promise.resolve(); },
    }),
    update: () => ({
      set: (v: any) => ({
        where: () => {
          const pending = rows.find((r: any) => r.status === "pending");
          if (pending) Object.assign(pending, v);
          return Promise.resolve();
        },
      }),
    }),
  };
}

describe("deprioritizeStaleIssues", () => {
  it("creates approval request for stale issue", async () => {
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 20);

    const issues = [{
      id: "i1", identifier: "BEC-80", title: "Old issue", description: "d",
      priority: 3, updatedAt: staleDate.toISOString(),
      team: { id: "team-1" }, url: "https://linear.app/BEC-80",
    }];
    const client = mockLinearClient(issues);
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-123"),
    };
    const db = mockApprovalDb();

    const requested = await deprioritizeStaleIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      staleDays: 14,
      minPriority: 3,
    });

    expect(requested).toEqual(["BEC-80"]);
    expect(slackNotifier.postApprovalRequest).toHaveBeenCalled();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].action).toBe("deprioritize");
  });
});

describe("cancelAbandonedIssues", () => {
  it("creates approval request for abandoned issue", async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 35);

    const issues = [{
      id: "i1", identifier: "BEC-90", title: "Abandoned", description: "d",
      priority: 4, updatedAt: oldDate.toISOString(),
      comments: { nodes: [] },
      team: { id: "team-1" }, url: "https://linear.app/BEC-90",
    }];
    const client = {
      ...mockLinearClient([]),
      issues: vi.fn()
        .mockResolvedValueOnce({ nodes: issues })   // Backlog
        .mockResolvedValueOnce({ nodes: [] }),       // Icebox
    };
    const slackNotifier = {
      postApprovalRequest: vi.fn().mockResolvedValue("ts-456"),
    };
    const db = mockApprovalDb();

    const requested = await cancelAbandonedIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      slackNotifier: slackNotifier as any,
      db: db as any,
      abandonedDays: 30,
    });

    expect(requested).toEqual(["BEC-90"]);
  });
});

describe("resolveApprovals", () => {
  it("executes approved deprioritize", async () => {
    const client = mockLinearClient([]);
    const slackNotifier = {
      checkApprovalReactions: vi.fn().mockResolvedValue("approved"),
    };
    const pendingApprovals = [{
      id: "appr-1",
      issueId: "BEC-80",
      action: "deprioritize" as const,
      reason: "stale",
      slackMessageTs: "ts-123",
      status: "pending" as const,
      createdAt: new Date(),
      resolvedAt: null,
    }];
    const db = mockApprovalDb();
    db.rows.push(...pendingApprovals.map((a) => ({ ...a })));

    const resolved = await resolveApprovals({
      linearClient: client as any,
      slackNotifier: slackNotifier as any,
      db: db as any,
      teamIds: ["team-1"],
      stateMap: defaultStateMap,
    });

    expect(resolved.resolved).toBe(1);
    expect(resolved.expired).toBe(0);
    expect(resolved.stillPending).toBe(0);
    expect(client.updateIssue).toHaveBeenCalledWith("resolved-id", expect.objectContaining({ stateId: "state-icebox" }));
    expect(client.createComment).toHaveBeenCalled();
  });

  it("expires approvals older than 48h", async () => {
    const oldDate = new Date();
    oldDate.setHours(oldDate.getHours() - 49);

    const slackNotifier = {
      checkApprovalReactions: vi.fn().mockResolvedValue("pending"),
      postApprovalExpired: vi.fn().mockResolvedValue(undefined),
    };
    const pendingApprovals = [{
      id: "appr-2",
      issueId: "BEC-81",
      action: "cancel" as const,
      reason: "abandoned",
      slackMessageTs: "ts-789",
      status: "pending" as const,
      createdAt: oldDate,
      resolvedAt: null,
    }];
    const db = mockApprovalDb();
    db.rows.push(...pendingApprovals.map((a) => ({ ...a })));

    const resolved = await resolveApprovals({
      linearClient: mockLinearClient([]) as any,
      slackNotifier: slackNotifier as any,
      db: db as any,
      teamIds: ["team-1"],
      stateMap: defaultStateMap,
    });

    expect(resolved.resolved).toBe(0);
    expect(resolved.expired).toBe(1);
    expect(resolved.stillPending).toBe(0);
    expect(slackNotifier.postApprovalExpired).toHaveBeenCalledWith("BEC-81");
  });
});
