import { describe, it, expect, vi, beforeEach } from "vitest";
import { PmSlackNotifier } from "../pm/slack.js";
import type { TickResult, BudgetGuardResult, ScopeBudget, CircuitBrokenIssue } from "../pm/types.js";
import { fetchCircuitBrokenIssues } from "../pm/actions/db-queries.js";

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ ok: true, ts: "1234567890.123456" }),
});

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockClear();
});

function emptyBudget(): BudgetGuardResult {
  return { promoteBlocked: false, activeCount: 0, tokenSpendPercent: 0, dailyTokensUsed: 0 };
}

function emptyTick(): TickResult {
  return {
    triaged: [],
    promoted: [],
    approvalsResolved: 0,
    approvalsPending: 0,
    deprioritizeRequested: [],
    cancelRequested: [],
    errors: [],
    budgetGuard: emptyBudget(),
  };
}

describe("PmSlackNotifier", () => {
  const notifier = new PmSlackNotifier({
    botToken: "xoxb-test-token",
    channelId: "C0123456789",
  });

  it("posts digest for non-empty tick", async () => {
    const tick: TickResult = {
      ...emptyTick(),
      triaged: [{ issueId: "BEC-1", priority: 2, labels: ["bug"], complexity: "small", rationale: "test", acceptanceCriteria: [] }],
      budgetGuard: { ...emptyBudget(), activeCount: 1, tokenSpendPercent: 30, dailyTokensUsed: 1500000 },
    };
    await notifier.postDigest(tick, 3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channel).toBe("C0123456789");
    expect(body.blocks).toBeDefined();
  });

  it("includes per-scope budget breakdown when scopes have warnings", async () => {
    const scopes: ScopeBudget[] = [
      { scope: { kind: "global" }, scopeLabel: "global", limit: 1_000_000, used: 800_000, percent: 80, tier: "warn-80" },
      { scope: { kind: "team", teamId: "TEAM-1" }, scopeLabel: "team TEAM-1", limit: 500_000, used: 450_000, percent: 90, tier: "warn-80" },
      { scope: { kind: "repo", repoUrl: "https://github.com/test/repo" }, scopeLabel: "repo https://github.com/test/repo", limit: 200_000, used: 100_000, percent: 50, tier: "warn-50" },
    ];
    const tick: TickResult = {
      ...emptyTick(),
      triaged: [{ issueId: "BEC-1", priority: 2, labels: ["bug"], complexity: "small", rationale: "test", acceptanceCriteria: [] }],
      budgetGuard: { ...emptyBudget(), activeCount: 1, tokenSpendPercent: 80 },
      budgetScopes: scopes,
    };
    await notifier.postDigest(tick, 3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text = body.blocks[0].text.text;
    expect(text).toContain("Budget by scope");
    expect(text).toContain("team TEAM-1");
    expect(text).toContain("90%");
    expect(text).not.toContain("global");
  });

  it("omits scope breakdown when all scopes are ok", async () => {
    const scopes: ScopeBudget[] = [
      { scope: { kind: "global" }, scopeLabel: "global", limit: 1_000_000, used: 100_000, percent: 10, tier: "ok" },
      { scope: { kind: "team", teamId: "TEAM-1" }, scopeLabel: "team TEAM-1", limit: 500_000, used: 50_000, percent: 10, tier: "ok" },
    ];
    const tick: TickResult = {
      ...emptyTick(),
      triaged: [{ issueId: "BEC-2", priority: 2, labels: ["bug"], complexity: "small", rationale: "test", acceptanceCriteria: [] }],
      budgetGuard: { ...emptyBudget(), activeCount: 1, tokenSpendPercent: 10 },
      budgetScopes: scopes,
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text = body.blocks[0].text.text;
    expect(text).not.toContain("Budget by scope");
  });

  it("skips digest for empty tick", async () => {
    await notifier.postDigest(emptyTick(), 3);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts approval request and returns ts", async () => {
    const ts = await notifier.postApprovalRequest(
      "BEC-42",
      "deprioritize",
      "Stale for 18 days",
      "https://linear.app/test/BEC-42",
    );
    expect(ts).toBe("1234567890.123456");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("checks reactions and returns pending when none", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, message: { reactions: [] } }),
    });
    const result = await notifier.checkApprovalReactions("1234567890.123456");
    expect(result).toBe("pending");
  });

  it("checks reactions and returns approved on white_check_mark", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        message: { reactions: [{ name: "white_check_mark", count: 1 }] },
      }),
    });
    const result = await notifier.checkApprovalReactions("1234567890.123456");
    expect(result).toBe("approved");
  });

  it("checks reactions and returns rejected on x", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        message: { reactions: [{ name: "x", count: 1 }] },
      }),
    });
    const result = await notifier.checkApprovalReactions("1234567890.123456");
    expect(result).toBe("rejected");
  });

  // BEC-223 — Circuit-Broken Issues section in digest

  it("omits circuit-broken section when circuitBrokenIssues is empty", async () => {
    const tick: TickResult = {
      ...emptyTick(),
      triaged: [{ issueId: "BEC-1", priority: 2, labels: ["bug"], complexity: "small", rationale: "test", acceptanceCriteria: [] }],
      circuitBrokenIssues: [],
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text = body.blocks[0].text.text;
    expect(text).not.toContain("Circuit-Broken");
  });

  it("omits circuit-broken section when circuitBrokenIssues is absent", async () => {
    const tick: TickResult = {
      ...emptyTick(),
      triaged: [{ issueId: "BEC-1", priority: 2, labels: ["bug"], complexity: "small", rationale: "test", acceptanceCriteria: [] }],
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text = body.blocks[0].text.text;
    expect(text).not.toContain("Circuit-Broken");
  });

  it("renders circuit-broken section for one broken issue", async () => {
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const broken: CircuitBrokenIssue = {
      issueId: "BEC-99",
      issueTitle: "Fix the authentication bug",
      errorMessage: "auth token expired",
      failedAt,
      url: "https://linear.app/test/issue/BEC-99",
    };
    const tick: TickResult = {
      ...emptyTick(),
      circuitBrokenIssues: [broken],
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text: string = body.blocks[0].text.text;
    expect(text).toContain("Circuit-Broken Issues");
    expect(text).toContain("<https://linear.app/test/issue/BEC-99|BEC-99>");
    expect(text).toContain("Fix the authentication bug");
    expect(text).toContain("auth token expired");
    expect(text).toContain("2024-06-15 10:30:00 UTC");
  });

  it("renders circuit-broken identifier without link when url is absent", async () => {
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const broken: CircuitBrokenIssue = {
      issueId: "BEC-99",
      issueTitle: "Fix the authentication bug",
      errorMessage: "auth token expired",
      failedAt,
    };
    const tick: TickResult = {
      ...emptyTick(),
      circuitBrokenIssues: [broken],
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text: string = body.blocks[0].text.text;
    expect(text).toContain("BEC-99");
    expect(text).not.toContain("<https://");
  });

  it("truncates title to 80 chars with ellipsis in circuit-broken section", async () => {
    const longTitle = "A".repeat(100);
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const broken: CircuitBrokenIssue = {
      issueId: "BEC-99",
      issueTitle: longTitle,
      failedAt,
    };
    const tick: TickResult = {
      ...emptyTick(),
      circuitBrokenIssues: [broken],
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text: string = body.blocks[0].text.text;
    // Title truncated to 79 chars + ellipsis = 80 chars displayed
    expect(text).toContain("A".repeat(79) + "…");
    expect(text).not.toContain("A".repeat(100));
  });

  it("truncates error_message to 200 chars with ellipsis in circuit-broken section", async () => {
    const longError = "E".repeat(250);
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const broken: CircuitBrokenIssue = {
      issueId: "BEC-99",
      issueTitle: "Short title",
      errorMessage: longError,
      failedAt,
    };
    const tick: TickResult = {
      ...emptyTick(),
      circuitBrokenIssues: [broken],
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text: string = body.blocks[0].text.text;
    expect(text).toContain("E".repeat(199) + "…");
    expect(text).not.toContain("E".repeat(250));
  });

  it("caps circuit-broken section at 10 issues and appends overflow count", async () => {
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const issues: CircuitBrokenIssue[] = Array.from({ length: 13 }, (_, i) => ({
      issueId: `BEC-${100 + i}`,
      issueTitle: `Issue ${i + 1}`,
      failedAt,
    }));
    const tick: TickResult = {
      ...emptyTick(),
      circuitBrokenIssues: issues,
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text: string = body.blocks[0].text.text;
    // First 10 issues shown
    expect(text).toContain("BEC-100");
    expect(text).toContain("BEC-109");
    // 11th and beyond not shown as entries
    expect(text).not.toContain("BEC-110");
    // Overflow footer
    expect(text).toContain("_+3 more_");
  });

  it("uses configurable minConsecutiveFailures in circuit-broken section header", async () => {
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const broken: CircuitBrokenIssue = {
      issueId: "BEC-99",
      issueTitle: "Fix the authentication bug",
      failedAt,
    };
    const tick: TickResult = {
      ...emptyTick(),
      circuitBrokenIssues: [broken],
    };
    await notifier.postDigest(tick, 3, 5);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text: string = body.blocks[0].text.text;
    expect(text).toContain("≥5 consecutive failures");
    expect(text).not.toContain("≥3 consecutive failures");
  });

  it("excludes recovered issues (section omitted when all pass batchCountConsecutiveFailures=0)", async () => {
    // Simulate the case where fetchCircuitBrokenIssues returns [] because
    // batchCountConsecutiveFailures returned 0 for all candidates (recovered).
    // At the postDigest level this is identical to the empty-array case.
    const tick: TickResult = {
      ...emptyTick(),
      triaged: [{ issueId: "BEC-5", priority: 2, labels: ["bug"], complexity: "small", rationale: "ok", acceptanceCriteria: [] }],
      circuitBrokenIssues: [], // recovered issue was filtered out by fetchCircuitBrokenIssues
    };
    await notifier.postDigest(tick, 3);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const text: string = body.blocks[0].text.text;
    expect(text).not.toContain("Circuit-Broken");
  });
});

// BEC-223 — fetchCircuitBrokenIssues unit tests
describe("fetchCircuitBrokenIssues", () => {
  // Helper: build a select-from-where-orderBy[-limit] chain that resolves to
  // `rows`. `fetchCircuitBrokenIssues`'s first query terminates in `.limit()`,
  // while `batchCountConsecutiveFailures` terminates in `.orderBy()`. We
  // make both terminals resolve to the same rows so the same builder can be
  // used for both call sites.
  function mockQuery(rows: any[]) {
    const terminal = {
      limit: vi.fn().mockResolvedValue(rows),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue(terminal),
        }),
      }),
    };
  }

  it("returns empty array when no failed runs in window", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue(mockQuery([])),
    } as any;
    const result = await fetchCircuitBrokenIssues(mockDb, 3, 7);
    expect(result).toEqual([]);
  });

  it("returns broken issue when consecutive failure count meets threshold", async () => {
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    // First select() call: the failed-runs-in-window query
    // Second select() call: batchCountConsecutiveFailures
    const mockDb = {
      select: vi.fn()
        .mockReturnValueOnce(mockQuery([
          {
            issueId: "BEC-42",
            issueTitle: "Broken issue",
            errorMessage: "some error",
            startedAt: failedAt,
            completedAt: failedAt,
          },
        ]))
        .mockReturnValueOnce(mockQuery([
          { issueId: "BEC-42", status: "failed" },
          { issueId: "BEC-42", status: "failed" },
          { issueId: "BEC-42", status: "failed" },
        ])),
    } as any;

    const result = await fetchCircuitBrokenIssues(mockDb, 3, 7);
    expect(result).toHaveLength(1);
    expect(result[0].issueId).toBe("BEC-42");
    expect(result[0].issueTitle).toBe("Broken issue");
    expect(result[0].errorMessage).toBe("some error");
  });

  it("excludes issue whose most-recent terminal run is completed (batchCount returns 0)", async () => {
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const mockDb = {
      select: vi.fn()
        .mockReturnValueOnce(mockQuery([
          {
            issueId: "BEC-42",
            issueTitle: "Recovered issue",
            errorMessage: "old error",
            startedAt: failedAt,
            completedAt: failedAt,
          },
        ]))
        // batchCountConsecutiveFailures: most recent terminal run is 'completed'
        .mockReturnValueOnce(mockQuery([
          { issueId: "BEC-42", status: "completed" }, // most recent is completed → recovered
          { issueId: "BEC-42", status: "failed" },
          { issueId: "BEC-42", status: "failed" },
        ])),
    } as any;

    const result = await fetchCircuitBrokenIssues(mockDb, 3, 7);
    // Issue had a failed run in the window but its most-recent terminal run is 'completed' → excluded
    expect(result).toHaveLength(0);
  });

  it("excludes issue with fewer consecutive failures than threshold", async () => {
    const failedAt = new Date("2024-06-15T10:30:00.000Z");
    const mockDb = {
      select: vi.fn()
        .mockReturnValueOnce(mockQuery([
          {
            issueId: "BEC-42",
            issueTitle: "Partially failing issue",
            errorMessage: "some error",
            startedAt: failedAt,
            completedAt: null,
          },
        ]))
        // Only 2 consecutive failures — below the threshold of 3
        .mockReturnValueOnce(mockQuery([
          { issueId: "BEC-42", status: "failed" },
          { issueId: "BEC-42", status: "failed" },
          { issueId: "BEC-42", status: "completed" },
        ])),
    } as any;

    const result = await fetchCircuitBrokenIssues(mockDb, 3, 7);
    expect(result).toHaveLength(0);
  });
});
