import { describe, it, expect, vi } from "vitest";
import { createHmac } from "crypto";
import {
  createSentryWebhookHandler,
  verifySentrySignature,
  makeSentryTitlePrefix,
  makeSentryIdempotencyMarker,
  type SentryIntegrationConfig,
  type SentryLinearClient,
} from "../../integrations/sentry.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIGNING_SECRET = "sentry-signing-secret";
const TEAM_ID = "team-abc";
const TRIAGE_STATE_ID = "state-triage-id";

const BASE_CONFIG: SentryIntegrationConfig = {
  signingSecret: SIGNING_SECRET,
  linearApiKey: "lin-api-key",
  linearTeamId: TEAM_ID,
  idempotencyWindowMs: 24 * 60 * 60 * 1000,
};

function sign(body: string, secret: string = SIGNING_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function makeSentryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "triggered",
    data: {
      issue: {
        id: "sentry-issue-123",
        shortId: "MY-PROJECT-1A2",
        title: "TypeError: Cannot read property 'foo' of undefined",
        url: "https://sentry.io/organizations/my-org/issues/sentry-issue-123/",
        project: "my-project",
        level: "error",
        culprit: "app/utils.js in doSomething",
        firstSeen: "2024-01-01T00:00:00.000Z",
        lastSeen: "2024-01-01T01:00:00.000Z",
      },
      event: {
        event_id: "event-uuid",
        level: "error",
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read property 'foo' of undefined",
              stacktrace: {
                frames: [
                  {
                    filename: "app/models.js",
                    function: "loadUser",
                    lineno: 10,
                    context_line: "  return db.find(id);",
                  },
                  {
                    filename: "app/utils.js",
                    function: "doSomething",
                    lineno: 42,
                    context_line: "  return obj.foo;",
                  },
                ],
              },
            },
          ],
        },
        breadcrumbs: {
          values: [
            {
              timestamp: "2024-01-01T00:59:00.000Z",
              message: "User logged in",
              category: "auth",
              level: "info",
            },
          ],
        },
      },
      triggered_rule: "High Volume Errors",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock Linear client factory
// ---------------------------------------------------------------------------

function makeMockLinear(
  existingIssues: Array<{ id: string; identifier: string; title: string }> = [],
): {
  client: SentryLinearClient;
  createIssue: ReturnType<typeof vi.fn>;
} {
  const createIssue = vi.fn().mockResolvedValue({
    issue: { id: "new-linear-id", identifier: "BEC-300" },
  });

  const client: SentryLinearClient = {
    issues: vi.fn().mockResolvedValue({ nodes: existingIssues }),
    workflowStates: vi.fn().mockResolvedValue({
      nodes: [{ id: TRIAGE_STATE_ID, name: "Triage" }],
    }),
    issueLabels: vi.fn().mockResolvedValue({
      nodes: [
        { id: "label-bug", name: "bug" },
        { id: "label-auto-impl", name: "auto-implement" },
      ],
    }),
    createIssue,
  };
  return { client, createIssue };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function postSentry(
  app: ReturnType<typeof createSentryWebhookHandler>,
  body: unknown,
  secret: string = SIGNING_SECRET,
) {
  const rawBody = JSON.stringify(body);
  const sig = sign(rawBody, secret);
  return app.request("/webhooks/sentry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentry-Hook-Signature": sig,
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// verifySentrySignature unit tests
// ---------------------------------------------------------------------------

describe("verifySentrySignature", () => {
  const body = JSON.stringify({ hello: "world" });

  it("returns true for valid HMAC-SHA256 signature", () => {
    const sig = sign(body);
    expect(verifySentrySignature(body, sig, SIGNING_SECRET)).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const sig = sign(body, "wrong-secret");
    expect(verifySentrySignature(body, sig, SIGNING_SECRET)).toBe(false);
  });

  it("returns false for tampered body", () => {
    const sig = sign(body);
    expect(verifySentrySignature(body + "x", sig, SIGNING_SECRET)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifySentrySignature(body, "", SIGNING_SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler integration tests
// ---------------------------------------------------------------------------

describe("createSentryWebhookHandler", () => {
  it("returns 401 for invalid signature", async () => {
    const { client } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    const rawBody = JSON.stringify(makeSentryPayload());

    const resp = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Hook-Signature": "bad-signature",
      },
      body: rawBody,
    });

    expect(resp.status).toBe(401);
    const json = await resp.json() as Record<string, unknown>;
    expect(json.error).toBe("Invalid signature");
  });

  it("returns 401 for correct format but wrong secret", async () => {
    const { client } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    const body = JSON.stringify(makeSentryPayload());
    const wrongSig = sign(body, "different-secret");

    const resp = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Hook-Signature": wrongSig,
      },
      body,
    });

    expect(resp.status).toBe(401);
  });

  it("creates a Linear ticket for a valid Sentry issue alert", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    const payload = makeSentryPayload();

    const resp = await postSentry(app, payload);
    expect(resp.status).toBe(200);

    const json = await resp.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.issueId).toBe("BEC-300");

    expect(createIssue).toHaveBeenCalledOnce();
    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.teamId).toBe(TEAM_ID);
    expect(callArg.stateId).toBe(TRIAGE_STATE_ID);
    // Title must include the Sentry issue ID prefix
    expect(callArg.title).toContain("[Sentry#sentry-issue-123]");
    // Description must include stack trace, breadcrumbs, affected files
    expect(callArg.description).toContain("TypeError");
    expect(callArg.description).toContain("app/utils.js");
    expect(callArg.description).toContain("User logged in");
    expect(callArg.description).toContain("Breadcrumbs");
    expect(callArg.description).toContain("Affected Files");
    // Labels set
    expect(callArg.labelIds).toContain("label-bug");
    expect(callArg.labelIds).toContain("label-auto-impl");
  });

  it("maps Sentry error level to Linear priority 2 (High)", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    await postSentry(app, makeSentryPayload());

    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.priority).toBe(2); // error → High
  });

  it("maps Sentry critical level to Linear priority 1 (Urgent)", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    const payload = makeSentryPayload();
    (payload as any).data.issue.level = "critical";
    (payload as any).data.event.level = "critical";

    await postSentry(app, payload);
    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.priority).toBe(1);
  });

  it("maps Sentry warning level to Linear priority 3 (Medium)", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    const payload = makeSentryPayload();
    (payload as any).data.issue.level = "warning";
    (payload as any).data.event.level = "warning";

    await postSentry(app, payload);
    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.priority).toBe(3);
  });

  it("maps Sentry info level to Linear priority 4 (Low)", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    const payload = makeSentryPayload();
    (payload as any).data.issue.level = "info";
    (payload as any).data.event.level = "info";

    await postSentry(app, payload);
    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.priority).toBe(4);
  });

  it("ticket description includes deploy notice", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    await postSentry(app, makeSentryPayload());

    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.description).toContain("Deploy information");
  });

  it("ticket description includes idempotency marker", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    await postSentry(app, makeSentryPayload());

    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    const marker = makeSentryIdempotencyMarker("sentry-issue-123");
    expect(callArg.description).toContain(marker);
  });

  it("returns existing ticket without creating duplicate (idempotency)", async () => {
    const existingTicket = {
      id: "existing-id",
      identifier: "BEC-200",
      title: "[Sentry#sentry-issue-123] TypeError",
    };
    const { client, createIssue } = makeMockLinear([existingTicket]);
    const app = createSentryWebhookHandler(BASE_CONFIG, client);

    const resp = await postSentry(app, makeSentryPayload());
    expect(resp.status).toBe(200);

    const json = await resp.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.deduplicated).toBe(true);
    expect(json.issueId).toBe("BEC-200");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("creates tickets in Triage state with bug + auto-implement labels", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    await postSentry(app, makeSentryPayload());

    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.stateId).toBe(TRIAGE_STATE_ID);
    expect(callArg.labelIds).toEqual(expect.arrayContaining(["label-bug", "label-auto-impl"]));
  });

  it("returns 200 when payload has no issue data", async () => {
    const { client, createIssue } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    await postSentry(app, { action: "triggered", data: {} });

    expect(createIssue).not.toHaveBeenCalled();
  });

  it("uses title prefix [Sentry#<id>] for dedup lookups", async () => {
    const { client } = makeMockLinear();
    const app = createSentryWebhookHandler(BASE_CONFIG, client);
    await postSentry(app, makeSentryPayload());

    const issueFilter = (client.issues as ReturnType<typeof vi.fn>).mock.calls[0][0] as any;
    expect(issueFilter.filter.title.startsWith).toBe(
      makeSentryTitlePrefix("sentry-issue-123"),
    );
  });
});
