import type { Policy } from "../types.js";

/**
 * TTL cache for GitHub team membership lookups. High-frequency CI webhooks on
 * a PR with multiple required teams otherwise call `listMembersInOrg` on every
 * check, exhausting GitHub's secondary rate limit.
 *
 * Cache key: `${org}/${team_slug}`. Stale entries are evicted on read.
 * Default TTL: 15 minutes (team rosters change infrequently).
 *
 * This is module-level state — acceptable here because (a) team membership is
 * not tenant-scoped in any way within a single process, and (b) the cache is
 * memory-only so key rotation requires a process restart anyway.
 */
const TEAM_CACHE_TTL_MS = 15 * 60 * 1000;
interface TeamCacheEntry {
  members: string[]; // lowercased logins
  expiresAt: number;
}
const teamCache = new Map<string, TeamCacheEntry>();

/** Test-only: clear the team membership cache between runs. */
export function _clearTeamMembershipCache(): void {
  teamCache.clear();
}

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
  // De-dup by user: listReviews returns reviews chronologically (oldest first),
  // so iterating and overwriting gives the latest state per user. A user who
  // APPROVED then CHANGES_REQUESTED must NOT count as approved.
  const latestByUser = new Map<string, string>();
  for (const r of reviews.data) {
    if (r.user) latestByUser.set(r.user.login.toLowerCase(), r.state);
  }
  const approved = new Set(
    Array.from(latestByUser.entries())
      .filter(([, state]) => state === "APPROVED")
      .map(([login]) => login),
  );

  const missingUsers = required.users.filter((u) => !approved.has(u.toLowerCase()));

  const missingTeams: string[] = [];
  const now = Date.now();
  for (const team of required.teams) {
    const cacheKey = `${owner}/${team}`;
    let memberLogins: string[];
    const cached = teamCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      memberLogins = cached.members;
    } else {
      const members = await octokit.teams.listMembersInOrg({ org: owner, team_slug: team });
      memberLogins = members.data.map((m) => m.login.toLowerCase());
      teamCache.set(cacheKey, { members: memberLogins, expiresAt: now + TEAM_CACHE_TTL_MS });
    }
    const memberSet = new Set(memberLogins);
    const anyApproved = Array.from(approved).some((u) => memberSet.has(u));
    if (!anyApproved) missingTeams.push(team);
  }

  return {
    satisfied: missingUsers.length === 0 && missingTeams.length === 0,
    missingUsers,
    missingTeams,
  };
}
