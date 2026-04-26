import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getAgentProfiles,
  DEFAULT_AGENT_PROFILES,
  _resetAgentProfilesCache,
} from "../executor/profiles.js";

const ORIGINAL = process.env.URATEAM_AGENT_PROFILES;

beforeEach(() => {
  delete process.env.URATEAM_AGENT_PROFILES;
  _resetAgentProfilesCache();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.URATEAM_AGENT_PROFILES;
  else process.env.URATEAM_AGENT_PROFILES = ORIGINAL;
  _resetAgentProfilesCache();
});

describe("getAgentProfiles defaults", () => {
  it("returns the built-in defaults when env var is unset", () => {
    expect(getAgentProfiles()).toEqual(DEFAULT_AGENT_PROFILES);
  });

  it("ships the documented test stage budget (urateam#38 baseline)", () => {
    // The whole point of urateam#38 is that this baseline is too tight
    // for bootstrapping. The override path is the fix; defaults are
    // unchanged. Asserting the known shape so a silent default bump
    // shows up in review.
    expect(DEFAULT_AGENT_PROFILES.test).toMatchObject({
      maxTurns: 25,
      maxInputTokens: 30_000,
      model: "claude-haiku-4-5",
    });
  });
});

describe("getAgentProfiles env override", () => {
  it("merges a partial override on top of defaults", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: { maxTurns: 50, maxInputTokens: 80_000 },
    });
    const p = getAgentProfiles();
    expect(p.test.maxTurns).toBe(50);
    expect(p.test.maxInputTokens).toBe(80_000);
    // Untouched fields keep their default
    expect(p.test.model).toBe("claude-haiku-4-5");
    expect(p.test.tools).toEqual(DEFAULT_AGENT_PROFILES.test!.tools);
    // Other stages untouched
    expect(p.implement).toEqual(DEFAULT_AGENT_PROFILES.implement);
  });

  it("can override the model + tools fields", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: { model: "claude-sonnet-4-6", tools: ["Read", "Bash"] },
    });
    const p = getAgentProfiles();
    expect(p.test.model).toBe("claude-sonnet-4-6");
    expect(p.test.tools).toEqual(["Read", "Bash"]);
  });

  it("ignores unknown stage names (logs warn) and keeps defaults intact", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      flarble: { maxTurns: 999 },
    });
    const p = getAgentProfiles();
    expect(p).toEqual(DEFAULT_AGENT_PROFILES);
    expect((p as any).flarble).toBeUndefined();
  });

  it("ignores malformed individual fields without dropping the rest of the stage", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: {
        maxTurns: 50,            // valid → applied
        maxInputTokens: "lots",  // invalid → ignored
        model: "",               // invalid (empty) → ignored
      },
    });
    const p = getAgentProfiles();
    expect(p.test.maxTurns).toBe(50);
    expect(p.test.maxInputTokens).toBe(30_000); // default kept
    expect(p.test.model).toBe("claude-haiku-4-5"); // default kept
  });

  it("rejects negative or zero numbers (must be positive integers)", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: { maxTurns: 0, maxInputTokens: -1 },
    });
    const p = getAgentProfiles();
    expect(p.test.maxTurns).toBe(25); // default kept
    expect(p.test.maxInputTokens).toBe(30_000); // default kept
  });

  it("falls back to defaults when env var is malformed JSON", () => {
    process.env.URATEAM_AGENT_PROFILES = "{not-json";
    const p = getAgentProfiles();
    expect(p).toEqual(DEFAULT_AGENT_PROFILES);
  });

  it("falls back to defaults when env var is a JSON array (must be an object)", () => {
    process.env.URATEAM_AGENT_PROFILES = "[]";
    const p = getAgentProfiles();
    expect(p).toEqual(DEFAULT_AGENT_PROFILES);
  });

  it("falls back to defaults when env var is `null`", () => {
    process.env.URATEAM_AGENT_PROFILES = "null";
    const p = getAgentProfiles();
    expect(p).toEqual(DEFAULT_AGENT_PROFILES);
  });

  it("ignores per-stage non-object values without dropping other stages", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: "should-be-an-object",
      implement: { maxTurns: 75 },
    });
    const p = getAgentProfiles();
    expect(p.test).toEqual(DEFAULT_AGENT_PROFILES.test); // bad value ignored
    expect(p.implement.maxTurns).toBe(75); // good value applied
  });

  it("caches the resolved profiles for the process lifetime", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: { maxTurns: 50 },
    });
    const first = getAgentProfiles();
    // Mutate the env after first read — should not re-read.
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: { maxTurns: 999 },
    });
    const second = getAgentProfiles();
    expect(second).toBe(first); // same object reference
    expect(second.test.maxTurns).toBe(50); // not 999
  });
});
