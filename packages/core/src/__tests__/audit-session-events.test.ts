import { describe, it, expect } from "vitest";
import {
  agentSessionCreatedEvent,
  agentSessionResumedEvent,
  agentSessionMissingFallbackEvent,
  systemSessionVolumeWarningEvent,
} from "../audit/events.js";

describe("agent session audit events (BEC-227)", () => {
  it("agentSessionCreatedEvent builds the canonical shape", () => {
    const e = agentSessionCreatedEvent({
      runId: "run-1",
      issueId: "BEC-227",
      sessionId: "uuid-abc",
    });
    expect(e.eventType).toBe("pipeline.agent_session_created");
    expect(e.payload).toMatchObject({ runId: "run-1", issueId: "BEC-227", sessionId: "uuid-abc" });
  });

  it("agentSessionResumedEvent includes priorMessageCount", () => {
    const e = agentSessionResumedEvent({
      runId: "run-1",
      issueId: "BEC-227",
      sessionId: "uuid-abc",
      stage: "implement",
      priorMessageCount: 42,
    });
    expect(e.eventType).toBe("pipeline.agent_session_resumed");
    expect(e.payload.priorMessageCount).toBe(42);
  });

  it("agentSessionMissingFallbackEvent records the missing path", () => {
    const e = agentSessionMissingFallbackEvent({
      runId: "run-1",
      issueId: "BEC-227",
      sessionId: "uuid-abc",
      reason: "jsonl-not-found",
    });
    expect(e.eventType).toBe("pipeline.agent_session_missing_fallback");
    expect(e.payload.reason).toBe("jsonl-not-found");
  });

  it("systemSessionVolumeWarningEvent fires at boot", () => {
    const e = systemSessionVolumeWarningEvent({ projectsDir: "/home/ura/.claude/projects", reason: "tmpfs" });
    expect(e.eventType).toBe("system.session_volume_warning");
  });
});
