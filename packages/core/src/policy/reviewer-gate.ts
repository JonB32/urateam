import type { Policy } from "../types.js";

export interface ReviewerRequest {
  users: string[];
  teams: string[];
}

export function buildReviewerRequest(policy: Policy | undefined): ReviewerRequest | null {
  const r = policy?.mandatoryReviewers;
  if (!r) return null;
  if (r.users.length === 0 && r.teams.length === 0) return null;
  return { users: [...r.users], teams: [...r.teams] };
}

export interface ApprovalVerification {
  satisfied: boolean;
  missingUsers: string[];
  missingTeams: string[];
}

/**
 * Query a GitHub PR's reviews and compare approving reviewers against the
 * required set. A required user is satisfied if they personally approved.
 * A required team is satisfied if any member of the team approved.
 */
export async function verifyApprovalsReceived(
  octokit: {
    pulls: {
      listReviews: (args: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{ data: Array<{ user: { login: string } | null; state: string }> }>;
    };
    teams: {
      listMembersInOrg: (args: {
        org: string;
        team_slug: string;
      }) => Promise<{ data: Array<{ login: string }> }>;
    };
  },
  owner: string,
  repo: string,
  pull_number: number,
  required: ReviewerRequest,
): Promise<ApprovalVerification> {
  if (required.users.length === 0 && required.teams.length === 0) {
    return { satisfied: true, missingUsers: [], missingTeams: [] };
  }

  const reviews = await octokit.pulls.listReviews({ owner, repo, pull_number });
  const approved = new Set(
    reviews.data
      .filter((r) => r.state === "APPROVED" && r.user)
      .map((r) => r.user!.login.toLowerCase()),
  );

  const missingUsers = required.users.filter((u) => !approved.has(u.toLowerCase()));

  const missingTeams: string[] = [];
  for (const team of required.teams) {
    const members = await octokit.teams.listMembersInOrg({ org: owner, team_slug: team });
    const memberSet = new Set(members.data.map((m) => m.login.toLowerCase()));
    const anyApproved = Array.from(approved).some((u) => memberSet.has(u));
    if (!anyApproved) missingTeams.push(team);
  }

  return {
    satisfied: missingUsers.length === 0 && missingTeams.length === 0,
    missingUsers,
    missingTeams,
  };
}
