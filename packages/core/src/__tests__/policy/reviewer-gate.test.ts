import { describe, it, expect, vi } from "vitest";
import { buildReviewerRequest, verifyApprovalsReceived } from "../../policy/reviewer-gate.js";

describe("buildReviewerRequest", () => {
  it("returns null when policy undefined", () => {
    expect(buildReviewerRequest(undefined)).toBeNull();
  });

  it("returns null when mandatoryReviewers absent", () => {
    expect(buildReviewerRequest({ pathBlocklist: [], overrideLabel: "x" } as any)).toBeNull();
  });

  it("returns null when both lists empty", () => {
    expect(
      buildReviewerRequest({
        pathBlocklist: [],
        overrideLabel: "x",
        mandatoryReviewers: { users: [], teams: [] },
      } as any),
    ).toBeNull();
  });

  it("returns users and teams when set", () => {
    const r = buildReviewerRequest({
      pathBlocklist: [],
      overrideLabel: "x",
      mandatoryReviewers: { users: ["alice"], teams: ["security"] },
    } as any);
    expect(r).toEqual({ users: ["alice"], teams: ["security"] });
  });
});

describe("verifyApprovalsReceived", () => {
  function stubOctokit(approvedUsers: string[], teamMembers: Record<string, string[]>) {
    return {
      pulls: {
        listReviews: vi.fn().mockResolvedValue({
          data: approvedUsers.map((u) => ({ user: { login: u }, state: "APPROVED" })),
        }),
      },
      teams: {
        listMembersInOrg: vi.fn().mockImplementation(({ team_slug }: { team_slug: string }) => ({
          data: (teamMembers[team_slug] ?? []).map((u) => ({ login: u })),
        })),
      },
    } as any;
  }

  it("satisfied=true when no required reviewers", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit([], {}),
      "owner",
      "repo",
      1,
      { users: [], teams: [] },
    );
    expect(r.satisfied).toBe(true);
  });

  it("satisfied when all required users approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["alice", "bob"], {}),
      "owner",
      "repo",
      1,
      { users: ["alice"], teams: [] },
    );
    expect(r.satisfied).toBe(true);
    expect(r.missingUsers).toEqual([]);
  });

  it("not satisfied when a required user has not approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["bob"], {}),
      "owner",
      "repo",
      1,
      { users: ["alice"], teams: [] },
    );
    expect(r.satisfied).toBe(false);
    expect(r.missingUsers).toEqual(["alice"]);
  });

  it("satisfied when a team member approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["alice"], { security: ["alice", "carol"] }),
      "owner",
      "repo",
      1,
      { users: [], teams: ["security"] },
    );
    expect(r.satisfied).toBe(true);
  });

  it("not satisfied when no member of a required team has approved", async () => {
    const r = await verifyApprovalsReceived(
      stubOctokit(["bob"], { security: ["alice", "carol"] }),
      "owner",
      "repo",
      1,
      { users: [], teams: ["security"] },
    );
    expect(r.satisfied).toBe(false);
    expect(r.missingTeams).toEqual(["security"]);
  });
});
