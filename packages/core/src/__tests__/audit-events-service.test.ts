import { describe, it, expect } from "vitest";
import {
  serviceInstalledEvent,
  serviceUninstalledEvent,
} from "../audit/events.js";

describe("serviceInstalledEvent", () => {
  it("emits eventType 'service.installed' with platform + unitPath in payload", () => {
    const evt = serviceInstalledEvent({
      platform: "darwin",
      unitPath: "/Users/x/Library/LaunchAgents/com.urateam.daemon.plist",
      actor: "cli:jonb",
    });
    expect(evt.eventType).toBe("service.installed");
    expect(evt.actor).toBe("cli:jonb");
    expect(evt.actorType).toBe("cli");
    expect(evt.payload.platform).toBe("darwin");
    expect(evt.payload.unitPath).toBe(
      "/Users/x/Library/LaunchAgents/com.urateam.daemon.plist",
    );
    expect(evt.id).toMatch(/^evt_/);
  });
});

describe("serviceUninstalledEvent", () => {
  it("emits eventType 'service.uninstalled' with platform + unitPath in payload", () => {
    const evt = serviceUninstalledEvent({
      platform: "linux",
      unitPath: "/home/x/.config/systemd/user/urateam.service",
      actor: "cli:x",
    });
    expect(evt.eventType).toBe("service.uninstalled");
    expect(evt.actor).toBe("cli:x");
    expect(evt.actorType).toBe("cli");
    expect(evt.payload.platform).toBe("linux");
    expect(evt.payload.unitPath).toBe(
      "/home/x/.config/systemd/user/urateam.service",
    );
  });
});
