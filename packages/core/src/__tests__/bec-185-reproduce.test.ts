/**
 * BEC-185 Reproduction Test
 *
 * Demonstrates: gh-linear-sync passes ALL labelFilters as a single
 * comma-separated string to the GitHub API, which the API treats as AND
 * (intersection). Issues that match only ONE of the labels are not returned.
 *
 * Steps to reproduce:
 *   1. Configure labelFilters with multiple values (e.g. ["bug", "enhancement"])
 *   2. Have GitHub issues that each carry only ONE of those labels
 *   3. Call runGhLinearSync — zero issues are synced despite matches existing
 */

import { describe, it, expect, vi } from "vitest";
import {
  runGhLinearSync,
  type GhLinearSyncConfig,
  type GitHubSyncClient,
  type LinearSyncClient,
  type GitHubIssue,
  type LinearSyncState,
  type LinearSyncIssue,
} from "../sync/gh-linear-sync.js";

// ---------------------------------------------------------------------------
// Minimal fixtures (copied from gh-linear-sync.test.ts)
// ---------------------------------------------------------------------------

const TEAM_ID = "team-abc";
const TRIAGE_STATE_ID = "state-triage-id";

const triageState: LinearSyncState = {
  id: TRIAGE_STATE_ID,
  name: "Triage",
  type: "triage",
};

function makeGhIssue(
  overrides: Partial<GitHubIssue> = {},
  labelNames: string[] = [],
): GitHubIssue {
  const number = overrides.number ?? 42;
  return {
    number,
    title: "Some bug report",
    body: "The app crashes on login.",
    html_url: `https://github.com/owner/repo/issues/${number}`,
    labels: labelNames.map((name) => ({ name })),
    state: "open",
    ...overrides,
  };
}

const defaultConfig: GhLinearSyncConfig = {
  githubToken: "gh-token",
  githubRepo: "owner/repo",
  linearApiKey: "lin-key",
  linearTeamId: TEAM_ID,
};

// ---------------------------------------------------------------------------
// Helper: build a mock GitHub client that SIMULATES the real GitHub API's
// AND semantics for comma-separated label parameters.
//
// Real API behaviour: `labels=bug,enhancement` → only returns issues that
// carry BOTH "bug" AND "enhancement" simultaneously.
// ---------------------------------------------------------------------------

function makeMockGitHubWithAndSemantics(allIssues: GitHubIssue[]) {
  const listIssues = vi.fn().mockImplementation(
    async ({ labels }: { labels?: string }) => {
      if (!labels) return allIssues;
      // GitHub AND semantics: every requested label must be present
      const required = labels.split(",").map((l: string) => l.trim());
      return allIssues.filter((issue) =>
        required.every((req) =>
          issue.labels.some((l) => l.name === req),
        ),
      );
    },
  );
  const client: GitHubSyncClient = {
    listIssues,
    closeIssue: vi.fn().mockResolvedValue(undefined),
  };
  return { client, listIssues };
}

function makeMockLinear(
  existingIssues: LinearSyncIssue[] = [],
  states: LinearSyncState[] = [triageState],
) {
  const createIssue = vi.fn().mockResolvedValue({
    issue: { id: "new-linear-id", identifier: "BEC-200" },
  });
  const client: LinearSyncClient = {
    issues: vi.fn().mockResolvedValue({ nodes: existingIssues }),
    workflowStates: vi.fn().mockResolvedValue({ nodes: states }),
    createIssue,
  };
  return { client, createIssue };
}

// ---------------------------------------------------------------------------
// Reproduction tests
// ---------------------------------------------------------------------------

describe("BEC-185 reproduction: multi-label OR vs AND semantics", () => {
  /**
   * Core reproduction:
   * Two issues exist — one labelled "bug", one labelled "enhancement".
   * Neither carries BOTH labels. With the current implementation (single API
   * call, comma-joined labels), the GitHub API's AND logic returns zero
   * issues, so nothing is synced.
   */
  it("BUG: single listIssues call with comma-joined labels returns 0 issues due to GitHub AND semantics", async () => {
    const bugIssue = makeGhIssue({ number: 1, title: "A bug" }, ["bug"]);
    const enhancementIssue = makeGhIssue(
      { number: 2, title: "An enhancement" },
      ["enhancement"],
    );

    const { client: ghClient, listIssues } =
      makeMockGitHubWithAndSemantics([bugIssue, enhancementIssue]);
    const { client: linClient, createIssue } = makeMockLinear();

    const result = await runGhLinearSync(
      { ...defaultConfig, labelFilters: ["bug", "enhancement"] },
      { github: ghClient, linear: linClient },
    );

    // Current code calls listIssues ONCE with labels="bug,enhancement"
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ labels: "bug,enhancement" }),
    );

    // BUG CONFIRMED: GitHub AND semantics means no issues are returned
    // even though 2 matching issues exist (one per label).
    // Therefore createIssue is never called and created=0.
    expect(createIssue).not.toHaveBeenCalled();
    expect(result.created).toBe(0);

    // This is wrong — we expected 2 issues to be created (one per label).
    // The correct result should be: result.created === 2
  });

  /**
   * Demonstrates the correct OR behaviour by calling listIssues once per
   * label and union-ing results. This is what the fix should implement.
   */
  it("EXPECTED: calling listIssues once per label and deduplicating gives correct OR results", async () => {
    const bugIssue = makeGhIssue({ number: 1, title: "A bug" }, ["bug"]);
    const enhancementIssue = makeGhIssue(
      { number: 2, title: "An enhancement" },
      ["enhancement"],
    );
    const bothLabels = makeGhIssue(
      { number: 3, title: "Bug that is also an enhancement" },
      ["bug", "enhancement"],
    );

    const { client: ghClient } = makeMockGitHubWithAndSemantics([
      bugIssue,
      enhancementIssue,
      bothLabels,
    ]);

    // Manually simulate what the FIX should do: call once per label, union results
    const bugResults = await ghClient.listIssues({
      owner: "owner",
      repo: "repo",
      labels: "bug",
      state: "open",
      per_page: 100,
    });
    const enhancementResults = await ghClient.listIssues({
      owner: "owner",
      repo: "repo",
      labels: "enhancement",
      state: "open",
      per_page: 100,
    });

    // Union by issue number (dedup)
    const all = [...bugResults, ...enhancementResults];
    const deduped = [...new Map(all.map((i) => [i.number, i])).values()];

    // 3 unique issues: #1 (bug only), #2 (enhancement only), #3 (both)
    expect(deduped).toHaveLength(3);
    expect(deduped.map((i) => i.number).sort()).toEqual([1, 2, 3]);
  });

  /**
   * Single-label case: should remain unaffected by the bug (works today
   * and must keep working after the fix).
   */
  it("single-label filter still works (unaffected by bug)", async () => {
    const bugIssue = makeGhIssue({ number: 1, title: "A bug" }, ["bug"]);
    const otherIssue = makeGhIssue(
      { number: 2, title: "Not a bug" },
      ["enhancement"],
    );

    const { client: ghClient, listIssues } =
      makeMockGitHubWithAndSemantics([bugIssue, otherIssue]);
    const { client: linClient, createIssue } = makeMockLinear();

    const result = await runGhLinearSync(
      { ...defaultConfig, labelFilters: ["bug"] },
      { github: ghClient, linear: linClient },
    );

    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ labels: "bug" }),
    );

    // Only issue #1 carries "bug" — correctly created
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(1);
  });

  /**
   * No labelFilters: all open issues should be fetched.
   */
  it("no labelFilters returns all open issues (baseline)", async () => {
    const issues = [
      makeGhIssue({ number: 1 }, ["bug"]),
      makeGhIssue({ number: 2 }, ["enhancement"]),
    ];

    const { client: ghClient, listIssues } =
      makeMockGitHubWithAndSemantics(issues);
    const { client: linClient, createIssue } = makeMockLinear();

    const result = await runGhLinearSync(defaultConfig, {
      github: ghClient,
      linear: linClient,
    });

    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ labels: undefined }),
    );
    expect(createIssue).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(2);
  });
});
