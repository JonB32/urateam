import { describe, it, expect, vi } from "vitest";
import {
  runGhLinearSync,
  findLinearTicketForGhIssue,
  createLinearTicketForGhIssue,
  makeIdempotencyMarker,
  type GhLinearSyncConfig,
  type GitHubSyncClient,
  type LinearSyncClient,
  type GitHubIssue,
  type LinearSyncIssue,
  type LinearSyncState,
} from "../sync/gh-linear-sync.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = "team-abc";
const TRIAGE_STATE_ID = "state-triage-id";
const DONE_STATE_ID = "state-done-id";

const triageState: LinearSyncState = {
  id: TRIAGE_STATE_ID,
  name: "Triage",
  type: "triage",
};
const doneState: LinearSyncState = {
  id: DONE_STATE_ID,
  name: "Done",
  type: "completed",
};

function makeGhIssue(
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    number: 42,
    title: "Some bug report",
    body: "The app crashes when login.",
    html_url: "https://github.com/owner/repo/issues/42",
    labels: [{ name: "urateam-quality-observer" }],
    state: "open",
    ...overrides,
  };
}

function makeLinearIssue(
  overrides: Partial<LinearSyncIssue> = {},
): LinearSyncIssue {
  return {
    id: "linear-issue-1",
    identifier: "BEC-100",
    title: "[GH#42] Some bug report",
    state: { name: "Triage", type: "triage" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockGitHub(issues: GitHubIssue[] = []): {
  client: GitHubSyncClient;
  closeIssue: ReturnType<typeof vi.fn>;
} {
  const closeIssue = vi.fn().mockResolvedValue(undefined);
  const client = {
    listIssues: vi.fn().mockResolvedValue(issues),
    closeIssue,
  } as unknown as GitHubSyncClient;
  return { client, closeIssue };
}

function makeMockLinear(
  existingIssues: LinearSyncIssue[] = [],
  states: LinearSyncState[] = [triageState],
): {
  client: LinearSyncClient;
  createIssue: ReturnType<typeof vi.fn>;
} {
  const createIssue = vi.fn().mockResolvedValue({
    issue: { id: "new-linear-id", identifier: "BEC-200" },
  });

  const client = {
    issues: vi.fn().mockResolvedValue({ nodes: existingIssues }),
    workflowStates: vi.fn().mockResolvedValue({ nodes: states }),
    createIssue,
  } as unknown as LinearSyncClient;
  return { client, createIssue };
}

const defaultConfig: GhLinearSyncConfig = {
  githubToken: "gh-token",
  githubRepo: "owner/repo",
  linearApiKey: "lin-key",
  linearTeamId: TEAM_ID,
};

// ---------------------------------------------------------------------------
// makeIdempotencyMarker
// ---------------------------------------------------------------------------

describe("makeIdempotencyMarker", () => {
  it("formats correctly", () => {
    expect(makeIdempotencyMarker(42)).toBe("<!-- gh-linear-sync:42 -->");
    expect(makeIdempotencyMarker(1)).toBe("<!-- gh-linear-sync:1 -->");
  });
});

// ---------------------------------------------------------------------------
// findLinearTicketForGhIssue
// ---------------------------------------------------------------------------

describe("findLinearTicketForGhIssue", () => {
  it("returns the first matching issue when one exists", async () => {
    const existingIssue = makeLinearIssue();
    const { client } = makeMockLinear([existingIssue]);

    const result = await findLinearTicketForGhIssue(client, 42, TEAM_ID);

    expect(result).toEqual(existingIssue);
    expect(client.issues).toHaveBeenCalledWith({
      filter: {
        team: { id: { eq: TEAM_ID } },
        title: { startsWith: "[GH#42]" },
      },
      first: 1,
    });
  });

  it("returns null when no matching issue exists", async () => {
    const { client } = makeMockLinear([]);

    const result = await findLinearTicketForGhIssue(client, 99, TEAM_ID);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createLinearTicketForGhIssue
// ---------------------------------------------------------------------------

describe("createLinearTicketForGhIssue", () => {
  it("creates a ticket with correct title, description, and idempotency marker", async () => {
    const ghIssue = makeGhIssue();
    const { client, createIssue } = makeMockLinear();

    const result = await createLinearTicketForGhIssue(
      client,
      ghIssue,
      TEAM_ID,
      TRIAGE_STATE_ID,
    );

    expect(result).toEqual({ id: "new-linear-id", identifier: "BEC-200" });
    expect(createIssue).toHaveBeenCalledWith({
      teamId: TEAM_ID,
      title: "[GH#42] Some bug report",
      description: expect.stringContaining("<!-- gh-linear-sync:42 -->"),
      stateId: TRIAGE_STATE_ID,
    });

    const call = createIssue.mock.calls[0][0];
    expect(call.description).toContain(ghIssue.body!);
    expect(call.description).toContain(ghIssue.html_url);
    expect(call.description).toContain("[GitHub Issue #42]");
  });

  it("handles null body gracefully", async () => {
    const ghIssue = makeGhIssue({ body: null });
    const { client, createIssue } = makeMockLinear();

    await createLinearTicketForGhIssue(client, ghIssue, TEAM_ID, TRIAGE_STATE_ID);

    const call = createIssue.mock.calls[0][0];
    expect(call.description).toContain("<!-- gh-linear-sync:42 -->");
  });

  it("throws when createIssue returns no issue", async () => {
    const ghIssue = makeGhIssue();
    const { client, createIssue } = makeMockLinear();
    createIssue.mockResolvedValue({ issue: null });

    await expect(
      createLinearTicketForGhIssue(client, ghIssue, TEAM_ID, TRIAGE_STATE_ID),
    ).rejects.toThrow("GH#42");
  });
});

// ---------------------------------------------------------------------------
// runGhLinearSync — round-trip integration path
// ---------------------------------------------------------------------------

describe("runGhLinearSync", () => {
  it("creates a Linear ticket for a new GitHub issue (round-trip)", async () => {
    const ghIssue = makeGhIssue({
      number: 10,
      title: "Quality Observer finding",
      labels: [{ name: "urateam-quality-observer" }],
    });
    const { client: ghClient } = makeMockGitHub([ghIssue]);
    const { client: linClient, createIssue } = makeMockLinear([], [triageState]);

    const result = await runGhLinearSync(defaultConfig, {
      github: ghClient,
      linear: linClient,
    });

    expect(result.processed).toBe(1);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(createIssue).toHaveBeenCalledOnce();
    const call = createIssue.mock.calls[0][0];
    expect(call.title).toBe("[GH#10] Quality Observer finding");
    expect(call.stateId).toBe(TRIAGE_STATE_ID);
    expect(call.description).toContain("<!-- gh-linear-sync:10 -->");
    expect(call.description).toContain("https://github.com/owner/repo/issues/10");
  });

  it("is idempotent — skips issues that already have a Linear ticket", async () => {
    const ghIssue = makeGhIssue({ number: 42 });
    const existing = makeLinearIssue();
    const { client: ghClient } = makeMockGitHub([ghIssue]);
    const { client: linClient, createIssue } = makeMockLinear([existing]);

    const result1 = await runGhLinearSync(defaultConfig, {
      github: ghClient,
      linear: linClient,
    });
    const result2 = await runGhLinearSync(defaultConfig, {
      github: ghClient,
      linear: linClient,
    });

    // Second run should also skip
    expect(result1.created).toBe(0);
    expect(result1.skipped).toBe(1);
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(1);
    // createIssue must NOT be called either time
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("throws when the Triage state is not found", async () => {
    const { client: ghClient } = makeMockGitHub([makeGhIssue()]);
    const { client: linClient } = makeMockLinear([], [doneState]); // no Triage state

    await expect(
      runGhLinearSync(defaultConfig, { github: ghClient, linear: linClient }),
    ).rejects.toThrow(/"Triage" not found/);
  });

  it("respects triageStateName override", async () => {
    const backlogState: LinearSyncState = {
      id: "state-backlog",
      name: "Backlog",
      type: "backlog",
    };
    const { client: ghClient } = makeMockGitHub([makeGhIssue()]);
    const { client: linClient, createIssue } = makeMockLinear([], [backlogState]);

    const result = await runGhLinearSync(
      { ...defaultConfig, triageStateName: "Backlog" },
      { github: ghClient, linear: linClient },
    );

    expect(result.created).toBe(1);
    expect(createIssue.mock.calls[0][0].stateId).toBe("state-backlog");
  });

  it("dry-run mode increments created count without calling createIssue", async () => {
    const { client: ghClient } = makeMockGitHub([makeGhIssue()]);
    const { client: linClient, createIssue } = makeMockLinear([], [triageState]);

    const result = await runGhLinearSync(
      { ...defaultConfig, dryRun: true },
      { github: ghClient, linear: linClient },
    );

    expect(result.created).toBe(1);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("bidirectional close: closes GH issue when Linear ticket is Done", async () => {
    const ghIssue = makeGhIssue({ number: 42, state: "open" });
    const doneTicket = makeLinearIssue({
      state: { name: "Done", type: "completed" },
    });
    const { client: ghClient, closeIssue } = makeMockGitHub([ghIssue]);
    const { client: linClient } = makeMockLinear([doneTicket], [triageState, doneState]);

    const result = await runGhLinearSync(
      { ...defaultConfig, bidirectionalClose: true },
      { github: ghClient, linear: linClient },
    );

    expect(result.closed).toBe(1);
    expect(closeIssue).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      issue_number: 42,
    });
  });

  it("bidirectional close: does NOT close GH issue when Linear ticket is in progress", async () => {
    const ghIssue = makeGhIssue({ number: 42, state: "open" });
    const inProgressTicket = makeLinearIssue({
      state: { name: "In Progress", type: "started" },
    });
    const { client: ghClient, closeIssue } = makeMockGitHub([ghIssue]);
    const { client: linClient } = makeMockLinear([inProgressTicket], [triageState]);

    const result = await runGhLinearSync(
      { ...defaultConfig, bidirectionalClose: true },
      { github: ghClient, linear: linClient },
    );

    expect(result.closed).toBe(0);
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("dry-run + bidirectionalClose: increments closed count without calling closeIssue", async () => {
    const ghIssue = makeGhIssue({ number: 42, state: "open" });
    const doneTicket = makeLinearIssue({
      state: { name: "Done", type: "completed" },
    });
    const { client: ghClient, closeIssue } = makeMockGitHub([ghIssue]);
    const { client: linClient } = makeMockLinear([doneTicket], [triageState, doneState]);

    const result = await runGhLinearSync(
      { ...defaultConfig, bidirectionalClose: true, dryRun: true },
      { github: ghClient, linear: linClient },
    );

    expect(result.closed).toBe(1);
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("collects per-issue errors without aborting the whole sync", async () => {
    const issues = [makeGhIssue({ number: 1 }), makeGhIssue({ number: 2 })];
    const { client: ghClient } = makeMockGitHub(issues);
    const { client: linClient, createIssue } = makeMockLinear([], [triageState]);

    // First call succeeds, second throws
    createIssue
      .mockResolvedValueOnce({ issue: { id: "ok", identifier: "BEC-1" } })
      .mockRejectedValueOnce(new Error("API rate limit"));

    const result = await runGhLinearSync(defaultConfig, {
      github: ghClient,
      linear: linClient,
    });

    expect(result.processed).toBe(2);
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("GH#2");
    expect(result.errors[0]).toContain("API rate limit");
  });

  it("passes label filters to GitHub listIssues", async () => {
    const { client: ghClient } = makeMockGitHub([]);
    const { client: linClient } = makeMockLinear([], [triageState]);

    await runGhLinearSync(
      { ...defaultConfig, labelFilters: ["urateam-quality-observer", "bug"] },
      { github: ghClient, linear: linClient },
    );

    expect(ghClient.listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ labels: "urateam-quality-observer,bug" }),
    );
  });

  it("processes multiple issues correctly", async () => {
    const issues = [
      makeGhIssue({ number: 10, title: "First issue" }),
      makeGhIssue({ number: 11, title: "Second issue" }),
      makeGhIssue({ number: 12, title: "Third issue (already synced)" }),
    ];
    const existingForIssue12 = makeLinearIssue({
      identifier: "BEC-50",
      title: "[GH#12] Third issue (already synced)",
    });

    const { client: ghClient } = makeMockGitHub(issues);
    const { client: linClient, createIssue } = makeMockLinear([], [triageState]);

    // Issues 10 and 11 have no match; issue 12 already exists.
    (linClient.issues as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ nodes: [] })   // GH#10
      .mockResolvedValueOnce({ nodes: [] })   // GH#11
      .mockResolvedValueOnce({ nodes: [existingForIssue12] }); // GH#12

    const result = await runGhLinearSync(defaultConfig, {
      github: ghClient,
      linear: linClient,
    });

    expect(result.processed).toBe(3);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(1);
    expect(createIssue).toHaveBeenCalledTimes(2);
  });
});
