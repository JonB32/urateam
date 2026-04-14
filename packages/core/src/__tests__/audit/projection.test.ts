import { describe, it, expect } from "vitest";
import {
  projectPipelineRun, projectPmApproval, projectBudgetAlert,
} from "../../audit/projection.js";

describe("projection", () => {
  it("projects a completed run into started + completed events", () => {
    const startedAt = new Date("2026-04-01T10:00:00Z");
    const completedAt = new Date("2026-04-01T10:05:00Z");
    const events = projectPipelineRun({
      id: "run_1", issueId: "BEC-1", pipelineKey: "auto-implement",
      status: "completed", startedAt, completedAt,
      totalInputTokens: 500, totalOutputTokens: 200,
      runType: "standard", parentRunId: null, linearTeamId: "T1",
      repoUrl: "https://github.com/x/y", autoMerged: null, autoMergeReason: null,
      errorMessage: null,
    } as any);
    expect(events.map(e => e.eventType)).toEqual(["run.started", "run.completed"]);
    expect(events[0].timestamp).toEqual(startedAt);
    expect(events[1].timestamp).toEqual(completedAt);
    expect(events[1].inputTokens).toBe(500);
    expect(events[1].outputTokens).toBe(200);
    expect(events[0].scope).toBe("team:T1");
  });

  it("projects a failed run into started + failed", () => {
    const events = projectPipelineRun({
      id: "run_2", issueId: "BEC-2", status: "failed",
      startedAt: new Date(), completedAt: new Date(),
      totalInputTokens: 0, totalOutputTokens: 0,
      runType: "standard", parentRunId: null, linearTeamId: null,
      repoUrl: "https://github.com/x/y", autoMerged: null, autoMergeReason: null,
      errorMessage: "boom",
    } as any);
    expect(events.map(e => e.eventType)).toEqual(["run.started", "run.failed"]);
    expect(events[1].payload.errorMessage).toBe("boom");
  });

  it("adds run.auto_merged when autoMerged=true", () => {
    const events = projectPipelineRun({
      id: "run_3", issueId: "BEC-3", status: "completed",
      startedAt: new Date(), completedAt: new Date(),
      totalInputTokens: 0, totalOutputTokens: 0,
      runType: "standard", parentRunId: null, linearTeamId: null,
      repoUrl: "x", autoMerged: true, autoMergeReason: "PR auto-merged",
      errorMessage: null,
    } as any);
    expect(events.map(e => e.eventType)).toContain("run.auto_merged");
  });

  it("adds run.auto_merge_skipped when autoMerged=false with reason", () => {
    const events = projectPipelineRun({
      id: "run_4", issueId: "BEC-4", status: "completed",
      startedAt: new Date(), completedAt: new Date(),
      totalInputTokens: 0, totalOutputTokens: 0,
      runType: "standard", parentRunId: null, linearTeamId: null,
      repoUrl: "x", autoMerged: false, autoMergeReason: "diff too large",
      errorMessage: null,
    } as any);
    expect(events.map(e => e.eventType)).toContain("run.auto_merge_skipped");
  });

  it("projects a pm approval into requested + resolved when resolvedAt set", () => {
    const events = projectPmApproval({
      id: "a1", issueId: "BEC-9", action: "cancel",
      reason: "stale", slackMessageTs: "ts", status: "approved",
      createdAt: new Date("2026-04-01"), resolvedAt: new Date("2026-04-02"),
    } as any);
    expect(events.map(e => e.eventType)).toEqual([
      "pm.approval_requested", "pm.approval_resolved",
    ]);
  });

  it("projects a budget alert", () => {
    const ev = projectBudgetAlert({
      id: "ba1", date: "2026-04-01", scope: "team:T1", threshold: 80,
      firedAt: new Date("2026-04-01T10:00:00Z"),
    } as any);
    expect(ev.eventType).toBe("budget.alert_fired");
    expect(ev.scope).toBe("team:T1");
    expect(ev.payload).toMatchObject({ threshold: 80, date: "2026-04-01" });
  });
});
