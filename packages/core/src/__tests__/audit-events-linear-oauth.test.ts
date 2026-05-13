import { describe, it, expect } from "vitest";
import { linearOauthCompletedEvent } from "../audit/events.js";

describe("linearOauthCompletedEvent", () => {
  it("emits eventType 'linear.oauth_completed' with workspaceId, never the token", () => {
    const evt = linearOauthCompletedEvent({
      workspaceId: "ws_abc123",
      workspaceName: "Acme Corp",
      actor: "cli:tester",
    });
    expect(evt.eventType).toBe("linear.oauth_completed");
    expect(evt.actor).toBe("cli:tester");
    expect(evt.actorType).toBe("cli");
    expect(evt.payload.workspaceId).toBe("ws_abc123");
    expect(evt.payload.workspaceName).toBe("Acme Corp");
    const json = JSON.stringify(evt.payload);
    expect(json).not.toMatch(/bearer/i);
    expect(json).not.toMatch(/eyJ/);
    expect(json).not.toMatch(/lin_oauth_/);
  });

  it("omits workspaceName when not provided", () => {
    const evt = linearOauthCompletedEvent({
      workspaceId: "ws_only",
      actor: "cli:tester",
    });
    expect(evt.payload.workspaceId).toBe("ws_only");
    expect(evt.payload.workspaceName).toBeUndefined();
  });
});
