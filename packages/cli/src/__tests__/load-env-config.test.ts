import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadEnvConfig } from "../lib/load-env-config.js";

const MINIMAL_START_ENV: NodeJS.ProcessEnv = {
  LINEAR_WEBHOOK_SECRET: "whsec_test",
  DASHBOARD_USER: "admin",
  DASHBOARD_PASSWORD: "secret",
  REPO_TEAM_ID: "team-abc",
  REPO_URL: "https://github.com/org/repo",
};

describe("loadEnvConfig", { timeout: 10_000 }, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errorSpy: any;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        throw new Error("__EXIT__");
      }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ── "start" mode ────────────────────────────────────────────────────────

  it("returns typed config for a minimal valid start environment", () => {
    const cfg = loadEnvConfig("start", MINIMAL_START_ENV);
    expect(cfg.LINEAR_WEBHOOK_SECRET).toBe("whsec_test");
    expect(cfg.DASHBOARD_USER).toBe("admin");
    expect(cfg.PORT).toBe(3000);
    expect(cfg.DASHBOARD_PORT).toBe(3001);
    expect(cfg.MAX_CONCURRENT_RUNS).toBe(3);
    expect(cfg.WORKTREE_TTL_HOURS).toBe(24);
    expect(cfg.PM_AGENT_ENABLED).toBe(false);
    expect(cfg.RELEASE_MANAGER_ENABLED).toBe(false);
    expect(cfg.URATEAM_SSO_ENABLED).toBe(false);
  });

  it("exits when LINEAR_WEBHOOK_SECRET is missing in start mode", () => {
    const env = { ...MINIMAL_START_ENV };
    delete env.LINEAR_WEBHOOK_SECRET;
    expect(() => loadEnvConfig("start", env)).toThrow("__EXIT__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    const msg = errorSpy.mock.calls[0]!.join(" ");
    expect(msg).toContain("LINEAR_WEBHOOK_SECRET");
  });

  it("exits when DASHBOARD_USER or DASHBOARD_PASSWORD is missing in start mode", () => {
    const env = { ...MINIMAL_START_ENV };
    delete env.DASHBOARD_USER;
    expect(() => loadEnvConfig("start", env)).toThrow("__EXIT__");
    const msg = errorSpy.mock.calls[0]!.join(" ");
    expect(msg).toContain("DASHBOARD_USER");
  });

  it("reports multiple missing required fields in one exit", () => {
    expect(() =>
      loadEnvConfig("start", {
        REPO_TEAM_ID: "t",
        REPO_URL: "https://github.com/o/r",
      }),
    ).toThrow("__EXIT__");
    const msg = errorSpy.mock.calls[0]!.join(" ");
    expect(msg).toContain("LINEAR_WEBHOOK_SECRET");
    expect(msg).toContain("DASHBOARD_USER");
    expect(msg).toContain("DASHBOARD_PASSWORD");
  });

  // ── "dev" mode ──────────────────────────────────────────────────────────

  it("accepts a minimal dev environment without webhook secret or dashboard auth", () => {
    const cfg = loadEnvConfig("dev", {
      REPO_TEAM_ID: "team-x",
      REPO_URL: "https://github.com/org/repo",
    });
    expect(cfg.LINEAR_WEBHOOK_SECRET).toBeUndefined();
    expect(cfg.DASHBOARD_USER).toBeUndefined();
    expect(cfg.PORT).toBe(3000);
  });

  // ── Numeric parsing ─────────────────────────────────────────────────────

  it("applies defaults for all numeric fields", () => {
    const cfg = loadEnvConfig("dev", { REPO_TEAM_ID: "t", REPO_URL: "u" });
    expect(cfg.PM_AGENT_CRON_INTERVAL_MS).toBe(1_800_000);
    expect(cfg.PM_AGENT_MAX_IN_FLIGHT).toBe(3);
    expect(cfg.PM_AGENT_MAX_CONSECUTIVE_FAILURES).toBe(3);
    expect(cfg.PM_AGENT_AGENT_BRANCH_TTL_DAYS).toBe(7);
    expect(cfg.PM_AGENT_STUCK_RUN_AGE_MIN).toBe(60);
    expect(cfg.URATEAM_SSO_SESSION_HOURS).toBe(24);
  });

  it("parses numeric env vars to typed numbers", () => {
    const cfg = loadEnvConfig("dev", {
      REPO_TEAM_ID: "t",
      REPO_URL: "u",
      PORT: "4000",
      DASHBOARD_PORT: "4001",
      MAX_CONCURRENT_RUNS: "5",
      WORKTREE_TTL_HOURS: "48",
      PM_AGENT_CRON_INTERVAL_MS: "900000",
      PM_AGENT_MAX_IN_FLIGHT: "6",
      PM_AGENT_MAX_CONSECUTIVE_FAILURES: "0",
      URATEAM_SSO_SESSION_HOURS: "12",
    });
    expect(cfg.PORT).toBe(4000);
    expect(cfg.DASHBOARD_PORT).toBe(4001);
    expect(cfg.MAX_CONCURRENT_RUNS).toBe(5);
    expect(cfg.WORKTREE_TTL_HOURS).toBe(48);
    expect(cfg.PM_AGENT_CRON_INTERVAL_MS).toBe(900_000);
    expect(cfg.PM_AGENT_MAX_IN_FLIGHT).toBe(6);
    // parseIntOr allows 0 for MAX_CONSECUTIVE_FAILURES (it uses parseIntOr not parsePosIntOr)
    expect(cfg.PM_AGENT_MAX_CONSECUTIVE_FAILURES).toBe(0);
    expect(cfg.URATEAM_SSO_SESSION_HOURS).toBe(12);
  });

  it("falls back to default when a numeric var is not a valid number", () => {
    const cfg = loadEnvConfig("dev", {
      REPO_TEAM_ID: "t",
      REPO_URL: "u",
      WORKTREE_TTL_HOURS: "abc",
    });
    expect(cfg.WORKTREE_TTL_HOURS).toBe(24);
  });

  // ── GITHUB_INSTALLATION_ID NaN guard ────────────────────────────────────

  it("returns undefined for GITHUB_INSTALLATION_ID when value is non-numeric", () => {
    const cfg = loadEnvConfig("dev", {
      REPO_TEAM_ID: "t",
      REPO_URL: "u",
      GITHUB_INSTALLATION_ID: "not-a-number",
    });
    expect(cfg.GITHUB_INSTALLATION_ID).toBeUndefined();
  });

  it("parses a valid GITHUB_INSTALLATION_ID", () => {
    const cfg = loadEnvConfig("dev", {
      REPO_TEAM_ID: "t",
      REPO_URL: "u",
      GITHUB_INSTALLATION_ID: "12345678",
    });
    expect(cfg.GITHUB_INSTALLATION_ID).toBe(12345678);
  });

  // ── Boolean parsing ─────────────────────────────────────────────────────

  it("parses boolean env vars correctly", () => {
    const cfg = loadEnvConfig("dev", {
      REPO_TEAM_ID: "t",
      REPO_URL: "u",
      PM_AGENT_ENABLED: "false",
      SLACK_ERROR_ALERTS: "true",
      REPO_DISABLE_PLUGIN_AUTODETECT: "true",
      PM_AGENT_PAUSED: "true",
      GITHUB_FEEDBACK_AUTO_TRIGGER: "false",
      URATEAM_SSO_COOKIE_SECURE: "false",
    });
    expect(cfg.PM_AGENT_ENABLED).toBe(false);
    expect(cfg.SLACK_ERROR_ALERTS).toBe(true);
    expect(cfg.REPO_DISABLE_PLUGIN_AUTODETECT).toBe(true);
    expect(cfg.PM_AGENT_PAUSED).toBe(true);
    expect(cfg.GITHUB_FEEDBACK_AUTO_TRIGGER).toBe(false);
    expect(cfg.URATEAM_SSO_COOKIE_SECURE).toBe(false);
  });

  it("defaults opt-out booleans to true when unset", () => {
    const cfg = loadEnvConfig("dev", { REPO_TEAM_ID: "t", REPO_URL: "u" });
    expect(cfg.GITHUB_FEEDBACK_AUTO_TRIGGER).toBe(true);
    expect(cfg.URATEAM_SSO_COOKIE_SECURE).toBe(true);
  });

  // ── PM Agent conditional requirements ───────────────────────────────────

  it("exits when PM_AGENT_ENABLED=true but SLACK_BOT_TOKEN is missing", () => {
    expect(() =>
      loadEnvConfig("start", {
        ...MINIMAL_START_ENV,
        PM_AGENT_ENABLED: "true",
        PM_AGENT_DAILY_TOKEN_BUDGET: "100000",
        PM_AGENT_SLACK_CHANNEL_ID: "C123",
        PM_AGENT_TEAM_IDS: "team-a",
      }),
    ).toThrow("__EXIT__");
    const msg = errorSpy.mock.calls[0]!.join(" ");
    expect(msg).toContain("SLACK_BOT_TOKEN");
    expect(msg).toContain("PM_AGENT_ENABLED=true");
  });

  it("exits when PM_AGENT_ENABLED=true but PM_AGENT_DAILY_TOKEN_BUDGET is missing", () => {
    expect(() =>
      loadEnvConfig("start", {
        ...MINIMAL_START_ENV,
        PM_AGENT_ENABLED: "true",
        SLACK_BOT_TOKEN: "xoxb-token",
        PM_AGENT_SLACK_CHANNEL_ID: "C123",
        PM_AGENT_TEAM_IDS: "team-a",
      }),
    ).toThrow("__EXIT__");
    const msg = errorSpy.mock.calls[0]!.join(" ");
    expect(msg).toContain("PM_AGENT_DAILY_TOKEN_BUDGET");
  });

  // ── Release Manager deferred validation fix ─────────────────────────────

  it("exits at boot when RELEASE_MANAGER_ENABLED=true but GITHUB_APP_ID is missing", () => {
    expect(() =>
      loadEnvConfig("start", {
        ...MINIMAL_START_ENV,
        RELEASE_MANAGER_ENABLED: "true",
      }),
    ).toThrow("__EXIT__");
    const msg = errorSpy.mock.calls[0]!.join(" ");
    expect(msg).toContain("GITHUB_APP_ID");
    expect(msg).toContain("GITHUB_PRIVATE_KEY_PATH");
  });

  it("accepts RELEASE_MANAGER_ENABLED=true when GitHub App credentials are present", () => {
    const cfg = loadEnvConfig("start", {
      ...MINIMAL_START_ENV,
      RELEASE_MANAGER_ENABLED: "true",
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY_PATH: "/path/to/key.pem",
    });
    expect(cfg.RELEASE_MANAGER_ENABLED).toBe(true);
    expect(cfg.RELEASE_MANAGER_SCHEDULE).toBe("*/30 * * * *");
    expect(cfg.RELEASE_MANAGER_BRANCH).toBe("main");
    expect(cfg.RELEASE_MANAGER_VERSION_BUMP).toBe("patch");
  });

  it("parses Release Manager trigger numeric vars", () => {
    const cfg = loadEnvConfig("start", {
      ...MINIMAL_START_ENV,
      RELEASE_MANAGER_ENABLED: "true",
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY_PATH: "/k.pem",
      RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE: "5",
      RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS: "48",
      RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES: "10",
    });
    expect(cfg.RELEASE_MANAGER_TRIGGER_MERGED_PRS_SINCE).toBe(5);
    expect(cfg.RELEASE_MANAGER_TRIGGER_TIME_SINCE_LAST_HOURS).toBe(48);
    expect(cfg.RELEASE_MANAGER_TRIGGER_CI_GREEN_FOR_MINUTES).toBe(10);
  });

  // ── Dual-defaults removed ────────────────────────────────────────────────

  it("EnvConfig is the single source of truth for PM Agent defaults (no ?? fallbacks needed)", () => {
    // Before BEC-198, start.ts had `?? "1800000"` fallbacks that shadowed Zod defaults.
    // Now EnvConfig applies the defaults and start.ts reads envConfig.PM_AGENT_CRON_INTERVAL_MS.
    const cfg = loadEnvConfig("dev", { REPO_TEAM_ID: "t", REPO_URL: "u" });
    expect(typeof cfg.PM_AGENT_CRON_INTERVAL_MS).toBe("number");
    expect(cfg.PM_AGENT_CRON_INTERVAL_MS).toBe(1_800_000);
    expect(typeof cfg.PM_AGENT_MAX_IN_FLIGHT).toBe("number");
    expect(cfg.PM_AGENT_MAX_IN_FLIGHT).toBe(3);
    expect(typeof cfg.PM_AGENT_MAX_CONSECUTIVE_FAILURES).toBe("number");
    expect(cfg.PM_AGENT_MAX_CONSECUTIVE_FAILURES).toBe(3);
  });
});
