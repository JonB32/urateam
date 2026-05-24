import { describe, it, expect } from "vitest";
import {
  tunnelStartedEvent,
  tunnelStoppedEvent,
} from "../audit/events.js";

describe("tunnelStartedEvent", () => {
  it("emits eventType 'tunnel.started' with provider + publicUrl + restartCount", () => {
    const evt = tunnelStartedEvent({
      provider: "cloudflare-quick",
      publicUrl: "https://abc123.trycloudflare.com",
      restartCount: 0,
    });
    expect(evt.eventType).toBe("tunnel.started");
    expect(evt.actor).toBe("system");
    expect(evt.actorType).toBe("system");
    expect(evt.payload.provider).toBe("cloudflare-quick");
    expect(evt.payload.publicUrl).toBe("https://abc123.trycloudflare.com");
    expect(evt.payload.restartCount).toBe(0);
  });

  it("accepts cloudflare-token provider", () => {
    const evt = tunnelStartedEvent({
      provider: "cloudflare-token",
      publicUrl: "https://urateam.example.com",
      restartCount: 2,
    });
    expect(evt.payload.provider).toBe("cloudflare-token");
    expect(evt.payload.restartCount).toBe(2);
  });
});

describe("tunnelStoppedEvent", () => {
  it("emits eventType 'tunnel.stopped' with exit metadata", () => {
    const evt = tunnelStoppedEvent({
      provider: "cloudflare-quick",
      restartCount: 3,
      exitCode: 1,
      signal: null,
    });
    expect(evt.eventType).toBe("tunnel.stopped");
    expect(evt.payload.exitCode).toBe(1);
    expect(evt.payload.signal).toBeNull();
    expect(evt.payload.restartCount).toBe(3);
  });

  it("accepts a signal name when the process was killed", () => {
    const evt = tunnelStoppedEvent({
      provider: "cloudflare-token",
      restartCount: 0,
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(evt.payload.exitCode).toBeNull();
    expect(evt.payload.signal).toBe("SIGTERM");
  });

  it("payload only contains provider/restartCount/exitCode/signal — never a token value", () => {
    const evt = tunnelStoppedEvent({
      provider: "cloudflare-token",
      restartCount: 0,
      exitCode: 0,
      signal: null,
    });
    expect(Object.keys(evt.payload).sort()).toEqual(
      ["exitCode", "provider", "restartCount", "signal"].sort(),
    );
    const json = JSON.stringify(evt.payload);
    expect(json).not.toMatch(/CLOUDFLARE_TUNNEL_TOKEN/);
    // A real Cloudflare tunnel token is a long base64-ish string; assert
    // nothing in the payload looks like a JWT (eyJ prefix) or a long
    // base64 blob.
    expect(json).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });
});
