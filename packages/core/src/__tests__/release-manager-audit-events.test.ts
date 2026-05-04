import { describe, it, expect } from "vitest";
import {
  releaseFiredEvent,
  releaseSkippedEvent,
  releaseApprovedEvent,
  releaseTagConflictEvent,
  releasePartialEvent,
  slackPostFailedEvent,
} from "../audit/events.js";
import { AuditEventSchema } from "../types.js";

describe("release-manager audit events", () => {
  it("releaseFiredEvent passes schema validation", () => {
    const evt = releaseFiredEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      tag: "v1.2.3",
      sha: "abcdef0",
      mergedPrCount: 5,
    });
    expect(evt.eventType).toBe("release.fired");
    expect(evt.actor).toBe("release-manager");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
    expect(evt.payload.tag).toBe("v1.2.3");
  });

  it("releaseSkippedEvent passes schema validation", () => {
    const evt = releaseSkippedEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      reason: "timeSinceLastHours not met",
    });
    expect(evt.eventType).toBe("release.skipped");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("releaseApprovedEvent passes schema validation", () => {
    const evt = releaseApprovedEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      approvedBy: "U123",
    });
    expect(evt.eventType).toBe("release.approved");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("releaseTagConflictEvent passes schema validation", () => {
    const evt = releaseTagConflictEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      tag: "v1.2.3",
    });
    expect(evt.eventType).toBe("release.tag_conflict");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("releasePartialEvent passes schema validation", () => {
    const evt = releasePartialEvent({
      repoUrl: "https://github.com/org/repo",
      branch: "main",
      tag: "v1.2.3",
      attemptCount: 3,
    });
    expect(evt.eventType).toBe("release.partial");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });

  it("slackPostFailedEvent passes schema validation", () => {
    const evt = slackPostFailedEvent({
      channel: "#releases",
      reason: "channel_not_found",
    });
    expect(evt.eventType).toBe("slack.post_failed");
    expect(() => AuditEventSchema.parse(evt)).not.toThrow();
  });
});
