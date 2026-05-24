import { describe, it, expect, beforeEach } from "vitest";
import {
  requestStop,
  getStopSignal,
  clearStopSignal,
  onStop,
  _clearAllSignals,
} from "../pipeline/control-signals.js";

describe("control-signals", () => {
  beforeEach(() => _clearAllSignals());

  it("records and retrieves a graceful signal", () => {
    requestStop("run-1", "graceful");
    expect(getStopSignal("run-1")).toBe("graceful");
  });

  it("records and retrieves a cancel signal", () => {
    requestStop("run-2", "cancel");
    expect(getStopSignal("run-2")).toBe("cancel");
  });

  it("upgrades graceful → cancel", () => {
    requestStop("run-3", "graceful");
    requestStop("run-3", "cancel");
    expect(getStopSignal("run-3")).toBe("cancel");
  });

  it("never downgrades cancel → graceful", () => {
    requestStop("run-4", "cancel");
    requestStop("run-4", "graceful");
    expect(getStopSignal("run-4")).toBe("cancel");
  });

  it("clearStopSignal removes the signal", () => {
    requestStop("run-5", "cancel");
    clearStopSignal("run-5");
    expect(getStopSignal("run-5")).toBeUndefined();
  });

  it("onStop fires when a cancel signal is recorded", () => {
    let fired = false;
    onStop("run-6", () => {
      fired = true;
    });
    requestStop("run-6", "cancel");
    expect(fired).toBe(true);
  });

  it("onStop does NOT fire on a graceful signal", () => {
    let fired = false;
    onStop("run-7", () => {
      fired = true;
    });
    requestStop("run-7", "graceful");
    expect(fired).toBe(false);
  });

  it("onStop fires synchronously when a cancel signal is already pending", () => {
    requestStop("run-8", "cancel");
    let fired = false;
    onStop("run-8", () => {
      fired = true;
    });
    expect(fired).toBe(true);
  });

  it("unsubscribe stops further callbacks", () => {
    const calls: number[] = [];
    const unsubscribe = onStop("run-9", () => calls.push(1));
    unsubscribe();
    requestStop("run-9", "cancel");
    expect(calls).toEqual([]);
  });

  it("scopes signals per run id", () => {
    requestStop("run-a", "cancel");
    requestStop("run-b", "graceful");
    expect(getStopSignal("run-a")).toBe("cancel");
    expect(getStopSignal("run-b")).toBe("graceful");
    expect(getStopSignal("run-c")).toBeUndefined();
  });

  it("listener exception does not break other listeners", () => {
    const calls: string[] = [];
    onStop("run-d", () => {
      calls.push("a");
      throw new Error("boom");
    });
    onStop("run-d", () => calls.push("b"));
    requestStop("run-d", "cancel");
    expect(calls).toEqual(["a", "b"]);
  });
});
