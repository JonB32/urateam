import { describe, it, expect } from "vitest";
import { decide } from "../release-manager/decide.js";
import type { CollectedState } from "../release-manager/types.js";
import type { QaCheckConfig, QaRunSnapshot } from "../qa/types.js";

const NOW = new Date("2026-05-01T12:00:00Z");

function baseState(over: Partial<CollectedState> = {}): CollectedState {
  return {
    lastTag: "v1.2.3",
    lastTagSha: "abcdef0",
    lastTagAt: new Date(NOW.getTime() - 48 * 3600 * 1000),
    headSha: "fedcba0",
    mergedCommitsSinceLastTag: 7,
    commitsSinceLastTag: [],
    ciStatus: "green",
    ciGreenSince: new Date(NOW.getTime() - 60 * 60 * 1000),
    hasFreshApproval: true,
    freshApprovalApprover: "U123",
    manualTagDetected: false,
    qaRun: null,
    ...over,
  };
}

describe("decide()", () => {
  it("fires when all set triggers pass", () => {
    const r = decide(baseState(), {
      mergedPRsSince: 5,
      timeSinceLastHours: 24,
      ciGreenForMinutes: 30,
      requireSlackApproval: true,
    }, NOW);
    expect(r.kind).toBe("fire");
  });

  it("returns the first failing trigger's reason in the documented order — mergedPRsSince fails first", () => {
    const r = decide(
      baseState({ mergedCommitsSinceLastTag: 1, lastTagAt: new Date(NOW.getTime() - 1 * 3600 * 1000) }),
      { mergedPRsSince: 5, timeSinceLastHours: 24, requireSlackApproval: false },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toMatch(/mergedPRsSince not met/);
  });

  it("checks timeSinceLastHours after mergedPRsSince passes", () => {
    const r = decide(
      baseState({ mergedCommitsSinceLastTag: 10, lastTagAt: new Date(NOW.getTime() - 1 * 3600 * 1000) }),
      { mergedPRsSince: 5, timeSinceLastHours: 24, requireSlackApproval: false },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toMatch(/timeSinceLastHours not met/);
  });

  it("checks ciGreenForMinutes after time check passes", () => {
    const r = decide(
      baseState({ ciStatus: "not-green", ciGreenSince: null }),
      { mergedPRsSince: 5, ciGreenForMinutes: 30, requireSlackApproval: false },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("ci_not_green");
  });

  it("checks requireSlackApproval last and returns 'awaiting-approval' (NOT 'skip') when it's the only failing trigger", () => {
    const r = decide(
      baseState({ hasFreshApproval: false }),
      { mergedPRsSince: 5, requireSlackApproval: true },
      NOW,
    );
    expect(r.kind).toBe("awaiting-approval");
    expect(r.reason).toBe("no_fresh_approval");
  });

  it("returns 'skip' (NOT 'awaiting-approval') when an earlier trigger fails alongside requireSlackApproval", () => {
    const r = decide(
      baseState({ mergedCommitsSinceLastTag: 1, hasFreshApproval: false }),
      { mergedPRsSince: 5, requireSlackApproval: true },
      NOW,
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toMatch(/mergedPRsSince not met/);
  });

  it("fires when only one trigger is set and it passes", () => {
    const r = decide(baseState(), { mergedPRsSince: 5, requireSlackApproval: false }, NOW);
    expect(r.kind).toBe("fire");
  });

  it("ignores unset triggers (no requireSlackApproval check when false)", () => {
    const r = decide(
      baseState({ hasFreshApproval: false }),
      { mergedPRsSince: 5, requireSlackApproval: false },
      NOW,
    );
    expect(r.kind).toBe("fire");
  });
});

describe("decide() qaCheck slot-4 integration", () => {
  const qaConfig: QaCheckConfig = {
    workflow: ".github/workflows/smoke.yml",
    timeoutMinutes: 30,
    linearTeamId: "team-uuid-123",
  };

  it("evaluates qaCheck after ciGreenForMinutes — qaCheck failure trumps requireSlackApproval", () => {
    // mergedPRsSince + ciGreen pass; qaCheck fails (no workflow); requireSlackApproval would also fail
    // expected: skip with qa_no_workflow (NOT awaiting-approval)
    const r = decide(
      baseState({
        hasFreshApproval: false,
      }),
      {
        mergedPRsSince: 5,
        ciGreenForMinutes: 30,
        qaCheck: qaConfig,
        requireSlackApproval: true,
      },
      NOW,
      { workflowFileExists: false, runConclusion: null },
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("qa_no_workflow");
    expect(r.kind === "skip" ? r.qaActionNeeded?.reason : undefined).toBe("qa_no_workflow");
  });

  it("bubbles qaActionNeeded for qa_needs_trigger when workflow exists but no run for SHA", () => {
    const r = decide(
      baseState({}),
      { mergedPRsSince: 5, qaCheck: qaConfig, requireSlackApproval: false },
      NOW,
      { workflowFileExists: true, runConclusion: null },
    );
    expect(r.kind).toBe("skip");
    expect(r.reason).toBe("qa_needs_trigger");
    expect(r.kind === "skip" ? r.qaActionNeeded?.reason : undefined).toBe("qa_needs_trigger");
  });

  it("returns fire when qaCheck passes alongside other passing triggers", () => {
    const qaRun: QaRunSnapshot = {
      runId: 99999,
      runSha: "fedcba0",
      triggeredAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    };
    const r = decide(
      baseState({ qaRun }),
      { mergedPRsSince: 5, qaCheck: qaConfig, requireSlackApproval: false },
      NOW,
      { workflowFileExists: true, runConclusion: "success" },
    );
    expect(r.kind).toBe("fire");
  });
});
