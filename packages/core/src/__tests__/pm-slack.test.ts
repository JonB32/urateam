import { describe, it, expect, vi, beforeEach } from "vitest";
import { PmSlackNotifier } from "../pm/slack.js";
import type { TickResult, BudgetGuardResult, ScopeBudget } from "../pm/types.js";

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
});
