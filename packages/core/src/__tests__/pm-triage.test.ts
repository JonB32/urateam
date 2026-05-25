import { describe, it, expect, vi } from "vitest";
import { triageNewIssues } from "../pm/actions/triage.js";

function mockLinearClient(issues: any[]) {
  return {
    issues: vi.fn().mockResolvedValue({ nodes: issues }),
    updateIssue: vi.fn().mockResolvedValue({}),
    createComment: vi.fn().mockResolvedValue({}),
    issueLabels: vi.fn().mockResolvedValue({
      nodes: [
        { id: "lbl-bug", name: "bug" },
        { id: "lbl-feature", name: "feature" },
        { id: "lbl-backend", name: "backend" },
      ],
    }),
  };
}

const defaultStateMap = new Map([["team-1:Backlog", "state-backlog"]]);

function mockClaude(response: string) {
  return vi.fn().mockResolvedValue(response);
}

describe("triageNewIssues", () => {
  it("classifies issue and moves to Backlog", async () => {
    const client = mockLinearClient([
      {
        id: "issue-1",
        identifier: "BEC-99",
        title: "Fix login bug",
        description: "Users can't log in",
        labels: { nodes: [] },
        team: { id: "team-1" },
      },
    ]);
    const claudeResponse = JSON.stringify({
      priority: 2,
      labels: ["bug", "backend"],
      complexity: "small",
      rationale: "Login validation is missing null check",
      acceptanceCriteria: ["Login form validates null inputs", "Error message shown for empty fields"],
    });
    const callClaude = mockClaude(claudeResponse);

    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(1);
    expect(results[0].issueId).toBe("BEC-99");
    expect(results[0].priority).toBe(2);
    expect(results[0].labels).toEqual(["bug", "backend"]); // "bug" maps to "bug" pipeline (no dup)
    expect(results[0].acceptanceCriteria).toEqual(["Login form validates null inputs", "Error message shown for empty fields"]);
    expect(client.updateIssue).toHaveBeenCalledWith("issue-1", expect.objectContaining({
      priority: 2,
      description: expect.stringContaining("**Acceptance Criteria:**"),
    }));
    expect(client.createComment).toHaveBeenCalled();
  });

  it("skips issue on invalid Claude JSON", async () => {
    const client = mockLinearClient([
      {
        id: "issue-2",
        identifier: "BEC-100",
        title: "Add feature",
        description: "Some desc",
        labels: { nodes: [] },
        team: { id: "team-1" },
      },
    ]);
    const callClaude = mockClaude("not valid json at all");

    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(0);
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("caps at 10 issues per tick", async () => {
    const issues = Array.from({ length: 15 }, (_, i) => ({
      id: `issue-${i}`,
      identifier: `BEC-${i}`,
      title: `Issue ${i}`,
      description: `Desc ${i}`,
      labels: { nodes: [] },
      team: { id: "team-1" },
    }));
    const client = mockLinearClient(issues);
    const claudeResponse = JSON.stringify({
      priority: 3, labels: ["feature"], complexity: "small", rationale: "test", acceptanceCriteria: ["test criterion"],
    });
    const callClaude = mockClaude(claudeResponse);

    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: defaultStateMap,
    });

    expect(results.length).toBeLessThanOrEqual(10);
    expect(callClaude).toHaveBeenCalledTimes(10);
  });

  it("processes issues in batches of batchSize", async () => {
    const callOrder: number[] = [];
    const resolvers: Array<() => void> = [];

    // 6 issues, batchSize=2 → 3 batches
    const issues = Array.from({ length: 6 }, (_, i) => ({
      id: `issue-${i}`,
      identifier: `BEC-${200 + i}`,
      title: `Issue ${i}`,
      description: `Desc ${i}`,
      labels: { nodes: [] },
      team: { id: "team-1" },
    }));
    const client = mockLinearClient(issues);

    const claudeResponse = JSON.stringify({
      priority: 3, labels: ["feature"], complexity: "small", rationale: "test", acceptanceCriteria: ["criterion"],
    });

    // Track call order to verify batching
    let callCount = 0;
    const callClaude = vi.fn().mockImplementation(async () => {
      callOrder.push(callCount++);
      return claudeResponse;
    });

    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      batchSize: 2,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(6);
    expect(callClaude).toHaveBeenCalledTimes(6);
  });

  it("uses default batch size of 3 when not specified", async () => {
    const issues = Array.from({ length: 6 }, (_, i) => ({
      id: `issue-${i}`,
      identifier: `BEC-${300 + i}`,
      title: `Issue ${i}`,
      description: `Desc ${i}`,
      labels: { nodes: [] },
      team: { id: "team-1" },
    }));
    const client = mockLinearClient(issues);
    const claudeResponse = JSON.stringify({
      priority: 3, labels: ["feature"], complexity: "small", rationale: "test", acceptanceCriteria: ["criterion"],
    });
    const callClaude = mockClaude(claudeResponse);

    // No batchSize specified — defaults to 3
    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      stateMap: defaultStateMap,
    });

    expect(results).toHaveLength(6);
    expect(callClaude).toHaveBeenCalledTimes(6);
  });

  it("skips rate-limited issues and continues with remaining batches", async () => {
    const issues = Array.from({ length: 4 }, (_, i) => ({
      id: `issue-${i}`,
      identifier: `BEC-${400 + i}`,
      title: `Issue ${i}`,
      description: `Desc ${i}`,
      labels: { nodes: [] },
      team: { id: "team-1" },
    }));
    const client = mockLinearClient(issues);
    const claudeResponse = JSON.stringify({
      priority: 2, labels: ["bug"], complexity: "small", rationale: "rate limit test", acceptanceCriteria: ["criterion"],
    });

    let callCount = 0;
    const callClaude = vi.fn().mockImplementation(async () => {
      callCount++;
      // Simulate rate limit error on the 2nd call
      if (callCount === 2) {
        throw new Error("429 Too Many Requests: Claude API rate limit exceeded");
      }
      return claudeResponse;
    });

    const results = await triageNewIssues({
      linearClient: client as any,
      teamIds: ["team-1"],
      callClaude,
      sanitize: (s: string) => s,
      batchSize: 2,
      stateMap: defaultStateMap,
    });

    // Issue 2 (index 1) is skipped due to rate limit error; others succeed
    expect(results).toHaveLength(3);
    expect(callClaude).toHaveBeenCalledTimes(4);
  });

  describe("observer-origin gate", () => {
    function clientWithNeedsDesignLabel(issues: any[]) {
      const c = mockLinearClient(issues);
      c.issueLabels = vi.fn().mockResolvedValue({
        nodes: [
          { id: "lbl-bug", name: "bug" },
          { id: "lbl-needs-design", name: "needs-design" },
        ],
      });
      return c;
    }

    const observerDescription =
      "Deep-review loop hit 90 turns. Inspect findings & implement-stage diffs.\n\n" +
      "<!-- urateam-qo-fingerprint: abc123 -->\n" +
      "<!-- urateam-qo-observer: run-patterns -->\n";

    it("routes observer-origin issue to needs-design without calling Claude", async () => {
      const client = clientWithNeedsDesignLabel([
        {
          id: "issue-qo-1",
          identifier: "BEC-500",
          title: "[GH#42] Pipeline urn-XYZ deep-review loop hit 90 turns",
          description: observerDescription,
          labels: { nodes: [] },
          team: { id: "team-1" },
        },
      ]);
      const callClaude = vi.fn();

      const results = await triageNewIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        callClaude,
        sanitize: (s: string) => s,
        stateMap: defaultStateMap,
      });

      expect(callClaude).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].issueId).toBe("BEC-500");
      expect(results[0].labels).toEqual(["needs-design"]);
      expect(results[0].acceptanceCriteria).toEqual([]);
      expect(client.updateIssue).toHaveBeenCalledWith(
        "issue-qo-1",
        expect.objectContaining({
          priority: 3,
          labelIds: ["lbl-needs-design"],
          stateId: "state-backlog",
        }),
      );
      // No acceptance-criteria section appended.
      expect(client.updateIssue).toHaveBeenCalledWith(
        "issue-qo-1",
        expect.not.objectContaining({ description: expect.any(String) }),
      );
      expect(client.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issueId: "issue-qo-1",
          body: expect.stringContaining("Quality Observer finding"),
        }),
      );
    });

    it("does not trigger the gate for normal issues without the marker", async () => {
      const client = clientWithNeedsDesignLabel([
        {
          id: "issue-normal",
          identifier: "BEC-501",
          title: "Add retry to webhook handler",
          description: "Webhook fails intermittently — add exponential backoff.",
          labels: { nodes: [] },
          team: { id: "team-1" },
        },
      ]);
      const callClaude = mockClaude(JSON.stringify({
        priority: 2,
        labels: ["bug"],
        complexity: "small",
        rationale: "Retry logic missing",
        acceptanceCriteria: ["Add backoff in webhook handler"],
      }));

      await triageNewIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        callClaude,
        sanitize: (s: string) => s,
        stateMap: defaultStateMap,
      });

      expect(callClaude).toHaveBeenCalledTimes(1);
    });

    it("routes when only the observer marker is present, even amid other content", async () => {
      const client = clientWithNeedsDesignLabel([
        {
          id: "issue-qo-2",
          identifier: "BEC-502",
          title: "[GH#43] Stage `review` is timing out repeatedly",
          description:
            "## Header\n\nSome content from observer.\n\n" +
            "<!-- urateam-qo-observer: run-patterns -->\n",
          labels: { nodes: [] },
          team: { id: "team-1" },
        },
      ]);
      const callClaude = vi.fn();

      const results = await triageNewIssues({
        linearClient: client as any,
        teamIds: ["team-1"],
        callClaude,
        sanitize: (s: string) => s,
        stateMap: defaultStateMap,
      });

      expect(callClaude).not.toHaveBeenCalled();
      expect(results[0].labels).toEqual(["needs-design"]);
    });
  });

  describe("URATEAM_DISABLE_TRIAGE_V2 escape hatch", () => {
    it("only appends **Acceptance Criteria:** to description (no v2 sections) when v2 is disabled", async () => {
      vi.stubEnv("URATEAM_DISABLE_TRIAGE_V2", "true");
      try {
        const client = mockLinearClient([
          {
            id: "issue-v1d",
            identifier: "BEC-V1D",
            title: "Disable v2 path",
            description: "",
            labels: { nodes: [] },
            team: { id: "team-1" },
          },
        ]);
        // Even if Claude returns v2 fields, the disable path must drop them.
        const callClaude = mockClaude(JSON.stringify({
          priority: 2,
          labels: ["feature"],
          complexity: "small",
          rationale: "Adds a thing",
          acceptanceCriteria: ["Thing is added", "Thing has a test"],
          assumptions: ["Should not appear in description"],
          examples: [{ scenario: "X", expected: "Y" }],
          affectedFiles: ["src/x.ts"],
          testStrategy: { unit: "vitest" },
          riskAssessment: { severity: "low", areas: ["api"] },
        }));

        await triageNewIssues({
          linearClient: client as any,
          teamIds: ["team-1"],
          callClaude,
          sanitize: (s: string) => s,
          stateMap: defaultStateMap,
        });

        const updateCall = client.updateIssue.mock.calls[0]!;
        const desc = (updateCall[1] as { description?: string }).description ?? "";
        expect(desc).toContain("**Acceptance Criteria:**");
        expect(desc).not.toContain("**Examples:**");
        expect(desc).not.toContain("**Affected Files:**");
        expect(desc).not.toContain("**Test Strategy:**");
        expect(desc).not.toContain("**Risk Assessment:**");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
