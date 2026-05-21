/**
 * BEC-238 reproduction: Slack bot token missing reactions:read scope.
 *
 * Confirms three gaps in the current implementation:
 * 1. checkApprovalReactions warns (not errors) on missing_scope and silently
 *    returns "pending" — approval is silently ignored.
 * 2. With N pending approvals, N warn lines fire per tick — no dedup.
 * 3. No startup probe exists on PmSlackNotifier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PmSlackNotifier } from "../pm/slack.js";

// Capture pino log calls via the module logger.
// We spy on the underlying createLogger output.
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

function makeMissingScope() {
  return {
    ok: true,
    json: () => Promise.resolve({ ok: false, error: "missing_scope" }),
  };
}

describe("BEC-238: reactions:read scope missing", () => {
  const notifier = new PmSlackNotifier({
    botToken: "xoxb-test",
    channelId: "C0000",
  });

  /**
   * Gap 1: missing_scope is logged at warn level, not error.
   * The operator has no idea the scope is absent without reading daemon logs.
   * Approval silently stays "pending" indefinitely.
   */
  it("Gap 1 — missing_scope logs warn (not error) and returns pending, silently ignoring the approval", async () => {
    mockFetch.mockResolvedValueOnce(makeMissingScope());

    const result = await notifier.checkApprovalReactions("ts-1");

    expect(result).toBe("pending");

    // BUG: currently logs warn, not error — operator sees no clear signal
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0];
    expect(ctx?.error).toBe("missing_scope");
    expect(msg).toMatch(/reactions\.get.*ok:false/i);

    // There should be an error-level log for a permanent scope issue,
    // but there isn't — this is the gap.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  /**
   * Gap 2: with 7 pending approvals in a tick, the warn fires 7× — no dedup.
   * The issue reports "7 occurrences in a single tick" in the dogfood logs.
   */
  it("Gap 2 — N pending approvals produce N warn lines per tick (no dedup)", async () => {
    const PENDING_COUNT = 7;
    for (let i = 0; i < PENDING_COUNT; i++) {
      mockFetch.mockResolvedValueOnce(makeMissingScope());
    }

    for (let i = 0; i < PENDING_COUNT; i++) {
      await notifier.checkApprovalReactions(`ts-${i}`);
    }

    // BUG: emits 7 duplicate warns — the flood described in the issue
    expect(warnSpy).toHaveBeenCalledTimes(PENDING_COUNT);
  });

  /**
   * Gap 3: PmSlackNotifier has no probeReactionsScope() startup method.
   * A missing scope is only discovered after the first tick fires live approvals.
   */
  it("Gap 3 — PmSlackNotifier exposes no startup scope probe", () => {
    // BUG: no probeReactionsScope / validateScopes method exists
    expect(typeof (notifier as any).probeReactionsScope).toBe("undefined");
    expect(typeof (notifier as any).validateScopes).toBe("undefined");
    expect(typeof (notifier as any).probeScopes).toBe("undefined");
  });
});
