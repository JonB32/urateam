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

  it("ships the documented test + implement stage budgets", () => {
    // BEC-162 (2026-05-06 BEC-138 dogfood): bumped from implement=50/test=25
    // to implement=100/test=50 after non-trivial sev-2 tickets repeatedly
    // hit the old caps. urateam#38 (bootstrapping) and the override path
    // are unchanged; this is just a more realistic baseline for
    // mature-repo work. Asserting exact shape so any future silent bump
    // shows up in review.
    expect(DEFAULT_AGENT_PROFILES.test).toMatchObject({
      maxTurns: 50,
      maxInputTokens: 30_000,
      model: "claude-haiku-4-5",
    });
    expect(DEFAULT_AGENT_PROFILES.implement).toMatchObject({
      maxTurns: 100,
      maxInputTokens: 100_000,
    });
  });
});

describe("getAgentProfiles env override", () => {
  it("merges a partial override on top of defaults", () => {
    // BEC-162 review: pick a maxTurns value that does NOT match the default
    // (50 post-bump). Otherwise a regression that drops the merge logic and
    // falls back to the default would silently pass this assertion.
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: { maxTurns: 75, maxInputTokens: 80_000 },
    });
    const p = getAgentProfiles();
    expect(p.test.maxTurns).toBe(75);
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
    // BEC-162 review: 75, not 50 — see "merges a partial override" above.
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: {
        maxTurns: 75,            // valid → applied
        maxInputTokens: "lots",  // invalid → ignored
        model: "",               // invalid (empty) → ignored
      },
    });
    const p = getAgentProfiles();
    expect(p.test.maxTurns).toBe(75);
    expect(p.test.maxInputTokens).toBe(30_000); // default kept
    expect(p.test.model).toBe("claude-haiku-4-5"); // default kept
  });

  it("rejects negative or zero numbers (must be positive integers)", () => {
    process.env.URATEAM_AGENT_PROFILES = JSON.stringify({
      test: { maxTurns: 0, maxInputTokens: -1 },
    });
    const p = getAgentProfiles();
    expect(p.test.maxTurns).toBe(50); // BEC-162 default kept
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
