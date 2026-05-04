import { describe, it, expect } from "vitest";
import { evalQaCheck } from "../release-manager/triggers.js";
import type { QaCheckConfig, QaRunSnapshot } from "../qa/types.js";

const NOW = new Date("2026-05-04T12:00:00Z");
const cfg: QaCheckConfig = {
  workflow: ".github/workflows/smoke.yml",
  timeoutMinutes: 30,
  linearTeamId: "team-uuid-123",
};

describe("evalQaCheck", () => {
  it("returns qa_no_workflow when workflowFileExists=false", () => {
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: false,
      qaRun: null,
      runConclusion: null,
      now: NOW,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("qa_no_workflow");
  });

  it("returns qa_needs_trigger when workflow exists but no run for current SHA", () => {
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: true,
      qaRun: null,
      runConclusion: null,
      now: NOW,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("qa_needs_trigger");
  });

  it("returns qa_needs_trigger when in-flight run is for stale SHA", () => {
    const qaRun: QaRunSnapshot = {
      runId: 99999,
      runSha: "old_sha",
      triggeredAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    };
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: true,
      qaRun,
      runConclusion: null,
      now: NOW,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("qa_needs_trigger");
  });

  it("returns qa_running when run is in flight for current SHA, not yet timed out", () => {
    const qaRun: QaRunSnapshot = {
      runId: 99999,
      runSha: "head_sha_1",
      triggeredAt: new Date(NOW.getTime() - 5 * 60 * 1000), // 5 min ago, < 30 min timeout
    };
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: true,
      qaRun,
      runConclusion: null,
      now: NOW,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("qa_running");
    if (result.pass === false && result.reason === "qa_running") {
      expect(result.runId).toBe(99999);
    }
  });

  it("returns qa_timed_out when run has been running > timeoutMinutes", () => {
    const qaRun: QaRunSnapshot = {
      runId: 99999,
      runSha: "head_sha_1",
      triggeredAt: new Date(NOW.getTime() - 35 * 60 * 1000), // 35 min ago, > 30 min timeout
    };
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: true,
      qaRun,
      runConclusion: null,
      now: NOW,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("qa_timed_out");
  });

  it("returns pass:true when run completed with conclusion=success", () => {
    const qaRun: QaRunSnapshot = {
      runId: 99999,
      runSha: "head_sha_1",
      triggeredAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    };
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: true,
      qaRun,
      runConclusion: "success",
      now: NOW,
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toMatch(/qa passed/i);
  });

  it("returns qa_failed for conclusion=failure", () => {
    const qaRun: QaRunSnapshot = {
      runId: 99999,
      runSha: "head_sha_1",
      triggeredAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    };
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: true,
      qaRun,
      runConclusion: "failure",
      now: NOW,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("qa_failed");
    if (result.pass === false && result.reason === "qa_failed") {
      expect(result.conclusion).toBe("failure");
    }
  });

  it("returns qa_failed for conclusion=cancelled", () => {
    const qaRun: QaRunSnapshot = {
      runId: 99999,
      runSha: "head_sha_1",
      triggeredAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    };
    const result = evalQaCheck({
      qaConfig: cfg,
      headSha: "head_sha_1",
      workflowFileExists: true,
      qaRun,
      runConclusion: "cancelled",
      now: NOW,
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("qa_failed");
    if (result.pass === false && result.reason === "qa_failed") {
      expect(result.conclusion).toBe("cancelled");
    }
  });
});
