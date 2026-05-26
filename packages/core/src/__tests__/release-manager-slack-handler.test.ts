import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq, isNull, and } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { releaseApprovals, releaseDecisions } from "../db/schema.js";
import {
  parseReleaseSubcommand,
  handleReleaseSubcommand,
} from "../release-manager/slack-handler.js";

function tmpDbPath(): string {
  const id = randomBytes(8).toString("hex");
  return `/tmp/laf-rm-slack-${id}.sqlite`;
}

describe("parseReleaseSubcommand", () => {
  it("parses 'approve'", () => {
    expect(parseReleaseSubcommand("approve")).toEqual({ kind: "approve" });
    expect(parseReleaseSubcommand("  APPROVE ")).toEqual({ kind: "approve" });
  });
  it("parses 'skip <reason>'", () => {
    expect(parseReleaseSubcommand("skip the world is on fire")).toEqual({
      kind: "skip",
      reason: "the world is on fire",
    });
  });
  it("returns help on bare 'skip' (no reason)", () => {
    expect(parseReleaseSubcommand("skip")).toEqual({ kind: "unknown", original: "skip" });
  });
  it("parses 'status'", () => {
    expect(parseReleaseSubcommand("status")).toEqual({ kind: "status" });
  });
  it("returns unknown for empty / garbage", () => {
    expect(parseReleaseSubcommand("")).toEqual({ kind: "unknown", original: "" });
    expect(parseReleaseSubcommand("foo bar")).toEqual({ kind: "unknown", original: "foo bar" });
  });
});

describe("handleReleaseSubcommand", () => {
  const paths: string[] = [];
  let db: any;
  const repoUrl = "https://github.com/org/repo";
  const branch = "main";

  beforeEach(async () => {
    const path = tmpDbPath();
    paths.push(path);
    const created = await createDb({ driver: "sqlite", connectionString: path });
    db = created as any;
  });

  afterEach(() => {
    for (const p of paths) {
      try { unlinkSync(p); } catch {}
      try { unlinkSync(p + "-wal"); } catch {}
      try { unlinkSync(p + "-shm"); } catch {}
    }
    paths.length = 0;
  });

  it("approve writes a release_approvals row and returns confirmation", async () => {
    const r = await handleReleaseSubcommand({
      cmd: { kind: "approve" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.text).toMatch(/Approved/i);
    expect(r.responseType).toBe("in_channel");
    const rows = await db.select().from(releaseApprovals).where(
      and(eq(releaseApprovals.repoUrl, repoUrl), isNull(releaseApprovals.consumedAt)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].approvedBy).toBe("U123");
  });

  it("approve is idempotent — second approve from same user returns the same friendly response (UNIQUE catches it)", async () => {
    await handleReleaseSubcommand({
      cmd: { kind: "approve" }, db, repoUrl, branch, slackUserId: "U123",
    });
    const r = await handleReleaseSubcommand({
      cmd: { kind: "approve" }, db, repoUrl, branch, slackUserId: "U123",
    });
    expect(r.text).toMatch(/already approved|Approved/i);
  });

  it("skip <reason> writes a release_decisions row and signals the scheduler to pause", async () => {
    const r = await handleReleaseSubcommand({
      cmd: { kind: "skip", reason: "deployment freeze" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.text).toMatch(/skipped/i);
    expect(r.text).toMatch(/deployment freeze/);
    expect(r.responseType).toBe("in_channel");
    const rows = await db.select().from(releaseDecisions).where(eq(releaseDecisions.repoUrl, repoUrl));
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe("skip");
    expect(rows[0].reason).toMatch(/manual:deployment freeze/);
  });

  it("status returns ephemeral with last 5 decisions", async () => {
    // Seed 6 decision rows
    for (let i = 0; i < 6; i++) {
      await db.insert(releaseDecisions).values({
        id: `rd_${i}`,
        repoUrl,
        branch,
        decidedAt: new Date(Date.now() - (6 - i) * 60_000),
        decision: "skip",
        reason: `reason_${i}`,
        triggerStateJson: "{}",
        attemptCount: 0,
      });
    }
    const r = await handleReleaseSubcommand({
      cmd: { kind: "status" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.responseType).toBe("ephemeral");
    expect(r.text).toMatch(/Recent decisions/);
    // Most recent 5 — reason_5..reason_1 — are present, reason_0 is not
    expect(r.text).toMatch(/reason_5/);
    expect(r.text).not.toMatch(/reason_0/);
  });

  it("unknown returns a help message", async () => {
    const r = await handleReleaseSubcommand({
      cmd: { kind: "unknown", original: "frobnicate" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
    });
    expect(r.text).toMatch(/Try.*approve.*skip.*status/i);
  });

  it("status renders rich output (last tag, proposed next, per-trigger glyphs) when octokit + config provided", async () => {
    const lastTagAt = new Date(Date.now() - 2 * 3600_000); // 2h ago → timeSinceLastHours=24 fails
    const ciGreenSince = new Date(Date.now() - 45 * 60_000); // 45m ago → ciGreenForMinutes=30 passes

    const mockOctokit = {
      repos: {
        getBranch: vi.fn().mockResolvedValue({ data: { commit: { sha: "abc123" } } }),
        listTags: vi.fn().mockResolvedValue({
          data: [{ name: "v0.1.30", commit: { sha: "tag_sha" } }],
        }),
        getCommit: vi.fn().mockResolvedValue({
          data: { commit: { committer: { date: lastTagAt.toISOString() } } },
        }),
        compareCommits: vi.fn().mockResolvedValue({
          data: {
            commits: Array(7).fill({ commit: { message: "fix: something" } }),
          },
        }),
        listCommits: vi.fn().mockResolvedValue({ data: [] }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              { status: "completed", conclusion: "success", completed_at: ciGreenSince.toISOString() },
            ],
          },
        }),
      },
    };

    const config = {
      enabled: true,
      schedule: "*/30 * * * *",
      versionBump: "patch" as const,
      branch: "main",
      triggers: {
        mergedPRsSince: 5,
        timeSinceLastHours: 24,
        ciGreenForMinutes: 30,
        requireSlackApproval: true as const,
      },
    };

    const r = await handleReleaseSubcommand({
      cmd: { kind: "status" },
      db,
      repoUrl,
      branch,
      slackUserId: "U123",
      octokit: mockOctokit as any,
      config: config as any,
    });

    expect(r.responseType).toBe("ephemeral");
    // Rich header fields
    expect(r.text).toMatch(/Last tag:.*v0\.1\.30/);
    expect(r.text).toMatch(/Proposed next:.*v0\.1\.31/);
    expect(r.text).toMatch(/Trigger state/);
    // ✓ mergedPRsSince=5 — have 7 (>= 5)
    expect(r.text).toMatch(/✓.*mergedPRsSince=5/);
    // ✗ timeSinceLastHours — only 2h elapsed, need 24h
    expect(r.text).toMatch(/✗.*timeSinceLastHours not met/);
    // ✓ ciGreenForMinutes=30 — CI green for 45m
    expect(r.text).toMatch(/✓.*ciGreenForMinutes=30/);
    // ⏳ requireSlackApproval — no fresh approval in DB
    expect(r.text).toMatch(/⏳.*requireSlackApproval=true \(no fresh approval\)/);
    // Still includes Recent decisions
    expect(r.text).toMatch(/Recent decisions/);
  });
});

import { createSlackInterface } from "../pm/slack-interface.js";

/** Sign a body with the test signing secret so it passes verifySlackSignature. */
async function signBody(body: string, secret = "test-secret-1234567890"): Promise<{ ts: string; sig: string }> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const crypto = await import("crypto");
  const sig =
    "v0=" +
    crypto.createHmac("sha256", secret)
      .update(`v0:${ts}:${body}`)
      .digest("hex");
  return { ts, sig };
}

describe("slack-interface /release dispatcher", () => {
  it("routes /release approve to releaseHandler", async () => {
    const releaseHandler = vi.fn(async () => ({ text: "ok-handler", responseType: "in_channel" as const }));
    const { router } = createSlackInterface({
      signingSecret: "test-secret-1234567890",
      botToken: "xoxb-test",
      channelId: "C123",
      releaseHandler,
    });
    const body = "command=%2Frelease&text=approve&user_id=U123&response_url=";
    const { ts, sig } = await signBody(body);
    const res = await router.fetch(new Request("http://localhost/slack/commands", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }));
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.text).toBe("ok-handler");
    expect(releaseHandler).toHaveBeenCalledWith({ text: "approve", userId: "U123" });
  });
});

describe("slack-interface /slack/interactivity — Block Kit button callbacks", () => {
  it("returns 401 when Slack signature is invalid", async () => {
    const releaseHandler = vi.fn(async () => ({ text: "ok", responseType: "in_channel" as const }));
    const { router } = createSlackInterface({
      signingSecret: "test-secret-1234567890",
      botToken: "xoxb-test",
      channelId: "C123",
      releaseHandler,
    });
    const res = await router.fetch(new Request("http://localhost/slack/interactivity", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": "9999999999",
        "X-Slack-Signature": "v0=badhash",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "payload=%7B%7D",
    }));
    expect(res.status).toBe(401);
  });

  it("routes release_approve button click to releaseHandler({ text: 'approve' })", async () => {
    const releaseHandler = vi.fn(async () => ({ text: "approved!", responseType: "in_channel" as const }));
    const { router } = createSlackInterface({
      signingSecret: "test-secret-1234567890",
      botToken: "xoxb-test",
      channelId: "C123",
      releaseHandler,
    });

    const payloadObj = {
      type: "block_actions",
      user: { id: "U999" },
      actions: [{ action_id: "release_approve", type: "button" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
    const { ts, sig } = await signBody(body);

    const res = await router.fetch(new Request("http://localhost/slack/interactivity", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }));
    expect(res.status).toBe(200);
    expect(releaseHandler).toHaveBeenCalledWith({ text: "approve", userId: "U999" });
  });

  it("routes release_skip button click to releaseHandler({ text: 'skip ...' })", async () => {
    const releaseHandler = vi.fn(async () => ({ text: "skipped!", responseType: "in_channel" as const }));
    const { router } = createSlackInterface({
      signingSecret: "test-secret-1234567890",
      botToken: "xoxb-test",
      channelId: "C123",
      releaseHandler,
    });

    const payloadObj = {
      type: "block_actions",
      user: { id: "U777" },
      actions: [{ action_id: "release_skip", type: "button", value: "Skipped via button" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
    const { ts, sig } = await signBody(body);

    const res = await router.fetch(new Request("http://localhost/slack/interactivity", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }));
    expect(res.status).toBe(200);
    expect(releaseHandler).toHaveBeenCalledWith({ text: "skip Skipped via button", userId: "U777" });
  });

  it("uses response_url to deliver the reply when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const releaseHandler = vi.fn(async () => ({ text: "approved!", responseType: "in_channel" as const }));
    const { router } = createSlackInterface({
      signingSecret: "test-secret-1234567890",
      botToken: "xoxb-test",
      channelId: "C123",
      releaseHandler,
    });

    const payloadObj = {
      type: "block_actions",
      user: { id: "U123" },
      actions: [{ action_id: "release_approve", type: "button" }],
      response_url: "https://hooks.slack.com/actions/test",
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
    const { ts, sig } = await signBody(body);

    const res = await router.fetch(new Request("http://localhost/slack/interactivity", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }));
    expect(res.status).toBe(200);
    // The response_url call is fire-and-forget; wait a tick for the microtask.
    await new Promise((r) => setTimeout(r, 0));
    const responseUrlCall = mockFetch.mock.calls.find(
      (args) => args[0] === "https://hooks.slack.com/actions/test",
    );
    expect(responseUrlCall).toBeDefined();
    const sentBody = JSON.parse(responseUrlCall![1].body as string);
    expect(sentBody.text).toBe("approved!");
  });

  it("acknowledges non-release action_ids without calling releaseHandler", async () => {
    const releaseHandler = vi.fn(async () => ({ text: "ok", responseType: "in_channel" as const }));
    const { router } = createSlackInterface({
      signingSecret: "test-secret-1234567890",
      botToken: "xoxb-test",
      channelId: "C123",
      releaseHandler,
    });

    const payloadObj = {
      type: "block_actions",
      user: { id: "U123" },
      actions: [{ action_id: "some_other_button", type: "button" }],
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payloadObj))}`;
    const { ts, sig } = await signBody(body);

    const res = await router.fetch(new Request("http://localhost/slack/interactivity", {
      method: "POST",
      headers: {
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }));
    expect(res.status).toBe(200);
    expect(releaseHandler).not.toHaveBeenCalled();
  });
});
