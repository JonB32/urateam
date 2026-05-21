/**
 * BEC-238: Slack bot token missing reactions:read scope.
 *
 * Verifies the fix:
 * 1. probeReactionsScope() logs error exactly once on missing_scope.
 * 2. probeReactionsScope() stays silent when scope is present (any other error).
 * 3. checkApprovalReactions() deduplicates missing_scope warns to one per
 *    notifier instance — no 7×/tick flood.
 * 4. checkApprovalReactions() still logs every occurrence of non-missing_scope
 *    errors (other error types are not deduped).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PmSlackNotifier } from "../pm/slack.js";

vi.mock("../logger.js", () => {
  const warnSpy = vi.fn();
  const errorSpy = vi.fn();
  return {
    createLogger: () => ({
      warn: warnSpy,
      error: errorSpy,
      info: vi.fn(),
      debug: vi.fn(),
    }),
    __warnSpy: warnSpy,
    __errorSpy: errorSpy,
  };
});

import * as loggerModule from "../logger.js";
const warnSpy = (loggerModule as any).__warnSpy as ReturnType<typeof vi.fn>;
const errorSpy = (loggerModule as any).__errorSpy as ReturnType<typeof vi.fn>;

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  warnSpy.mockReset();
  errorSpy.mockReset();
});

function fetchReturning(body: object) {
  return { ok: true, json: () => Promise.resolve(body) };
}

// ── probeReactionsScope ───────────────────────────────────────────────────────

describe("PmSlackNotifier.probeReactionsScope (BEC-238 AC2)", () => {
  it("logs error exactly once when reactions:read scope is missing", async () => {
    mockFetch.mockResolvedValueOnce(fetchReturning({ ok: false, error: "missing_scope" }));
    const notifier = new PmSlackNotifier({ botToken: "xoxb-test", channelId: "C0000" });

    await notifier.probeReactionsScope();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = errorSpy.mock.calls[0];
    expect(ctx?.error).toBe("missing_scope");
    expect(msg).toMatch(/reactions:read/);
    expect(msg).toMatch(/Fix:/);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays silent when scope is present (message_not_found means token can call reactions.get)", async () => {
    mockFetch.mockResolvedValueOnce(fetchReturning({ ok: false, error: "message_not_found" }));
    const notifier = new PmSlackNotifier({ botToken: "xoxb-test", channelId: "C0000" });

    await notifier.probeReactionsScope();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays silent when reactions.get succeeds (scope definitely present)", async () => {
    mockFetch.mockResolvedValueOnce(fetchReturning({ ok: true, message: { reactions: [] } }));
    const notifier = new PmSlackNotifier({ botToken: "xoxb-test", channelId: "C0000" });

    await notifier.probeReactionsScope();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs warn (not error) on fetch exception — probe is best-effort", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network timeout"));
    const notifier = new PmSlackNotifier({ botToken: "xoxb-test", channelId: "C0000" });

    await notifier.probeReactionsScope();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatch(/scope probe failed/);
  });
});

// ── checkApprovalReactions dedup (AC3) ───────────────────────────────────────

describe("PmSlackNotifier.checkApprovalReactions missing_scope dedup (BEC-238 AC3)", () => {
  it("logs warn only once across 7 consecutive missing_scope calls", async () => {
    const PENDING_COUNT = 7;
    for (let i = 0; i < PENDING_COUNT; i++) {
      mockFetch.mockResolvedValueOnce(fetchReturning({ ok: false, error: "missing_scope" }));
    }
    const notifier = new PmSlackNotifier({ botToken: "xoxb-test", channelId: "C0000" });

    for (let i = 0; i < PENDING_COUNT; i++) {
      const result = await notifier.checkApprovalReactions(`ts-${i}`);
      expect(result).toBe("pending");
    }

    // First call logs; subsequent 6 are silently deduped.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0];
    expect(ctx?.error).toBe("missing_scope");
    expect(msg).toMatch(/reactions\.get.*ok:false/i);
  });

  it("does NOT dedup non-missing_scope errors — each occurrence is logged", async () => {
    const ERROR_COUNT = 3;
    for (let i = 0; i < ERROR_COUNT; i++) {
      mockFetch.mockResolvedValueOnce(fetchReturning({ ok: false, error: "channel_not_found" }));
    }
    const notifier = new PmSlackNotifier({ botToken: "xoxb-test", channelId: "C0000" });

    for (let i = 0; i < ERROR_COUNT; i++) {
      await notifier.checkApprovalReactions(`ts-${i}`);
    }

    expect(warnSpy).toHaveBeenCalledTimes(ERROR_COUNT);
  });

  it("returns approved / rejected normally when scope is present", async () => {
    mockFetch.mockResolvedValueOnce(
      fetchReturning({ ok: true, message: { reactions: [{ name: "white_check_mark", count: 1 }] } }),
    );
    mockFetch.mockResolvedValueOnce(
      fetchReturning({ ok: true, message: { reactions: [{ name: "x", count: 1 }] } }),
    );
    const notifier = new PmSlackNotifier({ botToken: "xoxb-test", channelId: "C0000" });

    expect(await notifier.checkApprovalReactions("ts-approved")).toBe("approved");
    expect(await notifier.checkApprovalReactions("ts-rejected")).toBe("rejected");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
