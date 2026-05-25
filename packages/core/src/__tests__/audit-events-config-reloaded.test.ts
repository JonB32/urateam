import { describe, it, expect } from "vitest";
import { configReloadedEvent } from "../audit/events.js";

describe("configReloadedEvent", () => {
  it("emits eventType 'config.reloaded' with added/removed/modifiedSafe/modifiedUnsafe + sha256", () => {
    const evt = configReloadedEvent({
      added: ["https://github.com/a/x.git"],
      removed: ["https://github.com/a/y.git"],
      modifiedSafe: ["https://github.com/a/z.git"],
      modifiedUnsafe: [],
      sha256: "abc123",
    });
    expect(evt.eventType).toBe("config.reloaded");
    expect(evt.actor).toBe("system");
    expect(evt.actorType).toBe("system");
    expect(evt.payload.added).toEqual(["https://github.com/a/x.git"]);
    expect(evt.payload.removed).toEqual(["https://github.com/a/y.git"]);
    expect(evt.payload.modifiedSafe).toEqual(["https://github.com/a/z.git"]);
    expect(evt.payload.modifiedUnsafe).toEqual([]);
    expect(evt.payload.sha256).toBe("abc123");
  });

  it("empty diff still emits a valid event (operator-visible no-op reload)", () => {
    const evt = configReloadedEvent({
      added: [],
      removed: [],
      modifiedSafe: [],
      modifiedUnsafe: [],
      sha256: "0".repeat(64),
    });
    expect(evt.eventType).toBe("config.reloaded");
    expect(evt.payload.added).toEqual([]);
  });
});
