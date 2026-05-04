import { describe, it, expect } from "vitest";
import {
  qaRunTriggeredEvent,
  qaRunCompletedEvent,
  qaGapIssueFiledEvent,
} from "../audit/events.js";
import { AuditEventSchema } from "../types.js";

describe("qa audit events", () => {
  it("qaRunTriggeredEvent passes schema validation", () => {
    const evt = qaRunTriggeredEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      workflow: ".github/workflows/smoke.yml",
      runId: 12345,
      sha: "abcdef0",
    });
    expect(evt.eventType).toBe("qa.run_triggered");
    expect(evt.actor).toBe("release-manager");
    expect(evt.actorType).toBe("release-manager");
    expect(evt.scope).toBe("repo:https://github.com/org/repo");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
    expect(evt.payload.runId).toBe(12345);
  });

  it("qaRunCompletedEvent passes schema validation with conclusion", () => {
    const evt = qaRunCompletedEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      runId: 12345,
      conclusion: "success",
      durationMs: 600_000,
    });
    expect(evt.eventType).toBe("qa.run_completed");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
    expect(evt.payload.conclusion).toBe("success");
    expect(evt.payload.durationMs).toBe(600_000);
  });

  it("qaRunCompletedEvent supports synthetic timeout flag", () => {
    const evt = qaRunCompletedEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      runId: 12345,
      conclusion: "timed_out",
      durationMs: 1_800_000,
      synthetic: true,
    });
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
    expect(evt.payload.synthetic).toBe(true);
  });

  it("qaGapIssueFiledEvent passes schema validation", () => {
    const evt = qaGapIssueFiledEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      workflowPath: ".github/workflows/smoke.yml",
      linearIssueId: "BEC-150",
    });
    expect(evt.eventType).toBe("qa.gap_issue_filed");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
    expect(evt.payload.linearIssueId).toBe("BEC-150");
  });
});
