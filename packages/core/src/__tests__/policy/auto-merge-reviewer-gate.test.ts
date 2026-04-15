import { describe, it, expect, vi } from "vitest";
import { verifyApprovalsReceived } from "../../policy/reviewer-gate.js";

describe("auto-merge reviewer gate", () => {
  it("satisfied → auto-merge proceeds", async () => {
    const octokit = {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({
          data: [{ user: { login: "alice" }, state: "APPROVED" }],
        }),
      },
      teams: { listMembersInOrg: vi.fn() },
    } as any;
    const r = await verifyApprovalsReceived(octokit, "o", "r", 1, {
      users: ["alice"],
      teams: [],
    });
    expect(r.satisfied).toBe(true);
  });

  it("unsatisfied → auto-merge must skip with clear reason", async () => {
    const octokit = {
      pulls: { listReviews: vi.fn().mockResolvedValue({ data: [] }) },
      teams: {
        listMembersInOrg: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as any;
    const r = await verifyApprovalsReceived(octokit, "o", "r", 1, {
      users: ["alice"],
      teams: ["security"],
    });
    expect(r.satisfied).toBe(false);
    expect(r.missingUsers).toContain("alice");
    expect(r.missingTeams).toContain("security");
    const reason = `mandatory reviewers pending: users=${r.missingUsers.join(",") || "none"} teams=${r.missingTeams.join(",") || "none"}`;
    expect(reason).toContain("alice");
    expect(reason).toContain("security");
  });

  it("reason string uses 'none' when a list is empty", async () => {
    const octokit = {
      pulls: { listReviews: vi.fn().mockResolvedValue({ data: [] }) },
      teams: { listMembersInOrg: vi.fn() },
    } as any;
    const r = await verifyApprovalsReceived(octokit, "o", "r", 1, {
      users: ["bob"],
      teams: [],
    });
    const reason = `mandatory reviewers pending: users=${r.missingUsers.join(",") || "none"} teams=${r.missingTeams.join(",") || "none"}`;
    expect(reason).toBe("mandatory reviewers pending: users=bob teams=none");
  });
});
