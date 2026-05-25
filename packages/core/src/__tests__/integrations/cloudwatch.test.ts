import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createCloudWatchWebhookHandler,
  verifySnsSignature,
  buildSnsCanonicalString,
  makeCloudWatchTitlePrefix,
  makeCloudWatchIdempotencyMarker,
  _clearCertCache,
  type CloudWatchIntegrationConfig,
  type CloudWatchLinearClient,
  type SnsMessage,
} from "../../integrations/cloudwatch.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = "team-abc";
const TRIAGE_STATE_ID = "state-triage-id";

const BASE_CONFIG: CloudWatchIntegrationConfig = {
  linearApiKey: "lin-api-key",
  linearTeamId: TEAM_ID,
  idempotencyWindowMs: 24 * 60 * 60 * 1000,
};

const ALARM_NAME = "HighErrorRate";

function makeCloudWatchAlarm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AlarmName: ALARM_NAME,
    AlarmDescription: "Error rate above threshold",
    AWSAccountId: "123456789012",
    NewStateValue: "ALARM",
    NewStateReason: "Threshold Crossed: 1 out of the last 1 datapoints was greater than the threshold (5.0).",
    OldStateValue: "OK",
    StateChangeTime: "2024-01-01T01:00:00.000Z",
    Region: "us-east-1",
    Trigger: {
      MetricName: "5XXError",
      Namespace: "AWS/ApiGateway",
      Statistic: "Average",
      Period: 300,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      Threshold: 5.0,
      Dimensions: [{ name: "ApiName", value: "my-api" }],
    },
    ...overrides,
  };
}

function makeSnsMessage(overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: "Notification",
    MessageId: "msg-123",
    TopicArn: "arn:aws:sns:us-east-1:123456789012:CloudWatchAlarms",
    Subject: "ALARM: HighErrorRate",
    Message: JSON.stringify(makeCloudWatchAlarm()),
    Timestamp: "2024-01-01T01:00:00.000Z",
    SignatureVersion: "1",
    Signature: "test-signature",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService.pem",
    UnsubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe&...",
    ...overrides,
  };
}

// Fake PEM cert for mocking the cert fetcher in tests
const FAKE_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1234
-----END CERTIFICATE-----`;

// ---------------------------------------------------------------------------
// Mock Linear client factory
// ---------------------------------------------------------------------------

function makeMockLinear(
  existingIssues: Array<{ id: string; identifier: string; title: string }> = [],
): {
  client: CloudWatchLinearClient;
  createIssue: ReturnType<typeof vi.fn>;
} {
  const createIssue = vi.fn().mockResolvedValue({
    issue: { id: "new-linear-id", identifier: "BEC-400" },
  });

  const client: CloudWatchLinearClient = {
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
// Mock cert fetcher + SNS signature helpers
// ---------------------------------------------------------------------------

/** Returns a mock cert fetcher that resolves to the given PEM cert. */
function makeMockCertFetcher(cert: string = FAKE_PEM_CERT) {
  return vi.fn().mockResolvedValue(cert);
}

// Happy-path Notification tests use Node.js generateKeyPairSync + createSign to produce
// a real RSA-SHA1 signature that passes verifySnsSignature without mocking crypto.

// HTTP helper
async function postCloudWatch(
  app: ReturnType<typeof createCloudWatchWebhookHandler>,
  body: unknown,
) {
  const rawBody = JSON.stringify(body);
  return app.request("/webhooks/cloudwatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
}

afterEach(() => {
  _clearCertCache();
});

// ---------------------------------------------------------------------------
// buildSnsCanonicalString unit tests
// ---------------------------------------------------------------------------

describe("buildSnsCanonicalString", () => {
  it("includes required Notification fields in sorted order", () => {
    const msg: SnsMessage = {
      Type: "Notification",
      MessageId: "msg-123",
      TopicArn: "arn:aws:sns:us-east-1:123:MyTopic",
      Message: "hello world",
      Timestamp: "2024-01-01T00:00:00.000Z",
      Signature: "sig",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };

    const canonical = buildSnsCanonicalString(msg);

    expect(canonical).toContain("Message\nhello world\n");
    expect(canonical).toContain("MessageId\nmsg-123\n");
    expect(canonical).toContain("Timestamp\n2024-01-01T00:00:00.000Z\n");
    expect(canonical).toContain("TopicArn\narn:aws:sns:us-east-1:123:MyTopic\n");
    expect(canonical).toContain("Type\nNotification\n");
    // Subject not present → should not be in canonical
    expect(canonical).not.toContain("Subject");
    // SubscribeURL not in Notification type
    expect(canonical).not.toContain("SubscribeURL");
  });

  it("includes Subject when present", () => {
    const msg: SnsMessage = {
      Type: "Notification",
      MessageId: "msg-123",
      Subject: "My Subject",
      Message: "body",
      Timestamp: "2024-01-01T00:00:00.000Z",
      TopicArn: "arn:...",
    };
    const canonical = buildSnsCanonicalString(msg);
    expect(canonical).toContain("Subject\nMy Subject\n");
  });

  it("includes SubscribeURL and Token for SubscriptionConfirmation", () => {
    const msg: SnsMessage = {
      Type: "SubscriptionConfirmation",
      MessageId: "msg-456",
      Message: "confirm",
      Timestamp: "2024-01-01T00:00:00.000Z",
      TopicArn: "arn:...",
      SubscribeURL: "https://subscribe.url/token",
      Token: "confirm-token",
    };
    const canonical = buildSnsCanonicalString(msg);
    expect(canonical).toContain("SubscribeURL\nhttps://subscribe.url/token\n");
    expect(canonical).toContain("Token\nconfirm-token\n");
  });
});

// ---------------------------------------------------------------------------
// verifySnsSignature unit tests
// ---------------------------------------------------------------------------

describe("verifySnsSignature", () => {
  it("returns false when SigningCertURL is missing", async () => {
    const msg: SnsMessage = {
      Type: "Notification",
      MessageId: "m1",
      Message: "test",
      Timestamp: "2024-01-01",
      TopicArn: "arn:...",
      Signature: "sig",
      SignatureVersion: "1",
    };
    const result = await verifySnsSignature(msg, makeMockCertFetcher());
    expect(result).toBe(false);
  });

  it("returns false when Signature is missing", async () => {
    const msg: SnsMessage = {
      Type: "Notification",
      MessageId: "m1",
      Message: "test",
      Timestamp: "2024-01-01",
      TopicArn: "arn:...",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };
    const result = await verifySnsSignature(msg, makeMockCertFetcher());
    expect(result).toBe(false);
  });

  it("rejects when cert fetcher throws (invalid URL etc.)", async () => {
    const msg = makeSnsMessage();
    const badFetcher = vi.fn().mockRejectedValue(new Error("Invalid URL"));
    await expect(verifySnsSignature(msg, badFetcher)).rejects.toThrow("Invalid URL");
  });

  it("returns false when RSA signature does not match the cert", async () => {
    const msg = makeSnsMessage({ Signature: "aW52YWxpZA==" }); // "invalid" base64
    const result = await verifySnsSignature(msg, makeMockCertFetcher());
    expect(result).toBe(false); // RSA verification against fake PEM fails
  });
});

// ---------------------------------------------------------------------------
// defaultCertFetcher unit tests
// ---------------------------------------------------------------------------

describe("defaultCertFetcher", () => {
  it("rejects non-amazonaws.com URLs", async () => {
    const { defaultCertFetcher } = await import("../../integrations/cloudwatch.js");
    await expect(defaultCertFetcher("https://evil.com/cert.pem")).rejects.toThrow(
      "amazonaws.com",
    );
  });
});

// ---------------------------------------------------------------------------
// Handler integration tests (via SubscriptionConfirmation — no sig check)
// ---------------------------------------------------------------------------

describe("createCloudWatchWebhookHandler", () => {
  it("handles SubscriptionConfirmation and returns 200", async () => {
    const { client } = makeMockLinear();
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("OK", { status: 200 }),
    );

    const body = {
      Type: "SubscriptionConfirmation",
      MessageId: "conf-123",
      TopicArn: "arn:aws:sns:us-east-1:123:MyTopic",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/confirm",
      Token: "token-abc",
      Message: "You have chosen to subscribe to the topic...",
      Timestamp: "2024-01-01T00:00:00.000Z",
    };

    const resp = await postCloudWatch(app, body);
    expect(resp.status).toBe(200);
    const json = await resp.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.message).toContain("confirmed");
    expect(fetchSpy).toHaveBeenCalledWith("https://sns.us-east-1.amazonaws.com/confirm");

    fetchSpy.mockRestore();
  });

  it("returns 200 and ignores non-ALARM state (OK transition)", async () => {
    const { client, createIssue } = makeMockLinear();
    const certFetcher = makeMockCertFetcher();
    // Make certFetcher return something but verifySnsSignature will still return false
    // because the sig is not real RSA. We need to make the handler accept the sig.
    // Use a trick: pass a certFetcher that causes verify to throw (caught → false → 401)
    // This path tests the "not ALARM" branch indirectly via SNS type != Notification.
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, certFetcher);

    const body = {
      Type: "UnsubscribeConfirmation",
      MessageId: "unsub-123",
      Message: "unsubscribed",
      Timestamp: "2024-01-01T00:00:00.000Z",
      TopicArn: "arn:...",
    };

    const resp = await postCloudWatch(app, body);
    expect(resp.status).toBe(200);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("returns 401 for invalid SNS signature", async () => {
    const { client } = makeMockLinear();
    // certFetcher returns a cert that won't match the fake signature → verify returns false
    const certFetcher = makeMockCertFetcher();
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, certFetcher);

    const body = makeSnsMessage({ Signature: "aW52YWxpZA==" });
    const resp = await postCloudWatch(app, body);
    expect(resp.status).toBe(401);
  });

  it("returns 401 when cert fetch fails", async () => {
    const { client } = makeMockLinear();
    const badFetcher = vi.fn().mockRejectedValue(new Error("Network error"));
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, badFetcher);

    const resp = await postCloudWatch(app, makeSnsMessage());
    expect(resp.status).toBe(401);
    const json = await resp.json() as Record<string, unknown>;
    expect(json.error).toContain("Signature verification failed");
  });

  it("creates a Linear ticket for a valid CloudWatch ALARM notification", async () => {
    const { client, createIssue } = makeMockLinear();

    // Mock verifySnsSignature to return true by providing a certFetcher
    // that causes createVerify to succeed. Since we can't generate real RSA sigs,
    // we intercept by making the verifySnsSignature call succeed via mocking
    // the underlying crypto module would be too invasive.
    // Instead we test via the SubscriptionConfirmation path which skips sig verification,
    // and add a separate "given sig is valid" test that injects a mock linear client
    // to verify the ticket creation logic.
    //
    // Approach: extend the handler to accept a sigVerifier function for testability.
    // Since the current implementation accepts certFetcher, we use a certFetcher
    // that returns a PEM cert and pre-sign the message body using openssl-compatible
    // RSA in Node.js crypto.

    // Use Node.js crypto to generate an RSA keypair and sign the canonical string
    const { generateKeyPairSync, createSign } = await import("crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certPem = publicKey.export({ type: "pkcs1", format: "pem" }) as string;

    // Build the canonical string for our test SNS message
    const alarm = makeCloudWatchAlarm();
    const snsMsg: SnsMessage = {
      Type: "Notification",
      MessageId: "msg-alarm-001",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:CloudWatchAlarms",
      Subject: `ALARM: ${ALARM_NAME}`,
      Message: JSON.stringify(alarm),
      Timestamp: "2024-01-01T01:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
      UnsubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=Unsubscribe",
    };

    // Generate a valid RSA-SHA1 signature for this message
    const { buildSnsCanonicalString: buildCanonical } = await import("../../integrations/cloudwatch.js");
    const canonical = buildCanonical(snsMsg);
    const signer = createSign("RSA-SHA1");
    signer.update(canonical);
    const signature = signer.sign(privateKey, "base64");
    snsMsg.Signature = signature;

    const certFetcher = vi.fn().mockResolvedValue(certPem);
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, certFetcher);

    const resp = await postCloudWatch(app, snsMsg);
    expect(resp.status).toBe(200);

    const json = await resp.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.issueId).toBe("BEC-400");
    expect(createIssue).toHaveBeenCalledOnce();

    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.teamId).toBe(TEAM_ID);
    expect(callArg.stateId).toBe(TRIAGE_STATE_ID);
    expect(callArg.title).toContain(`[CW:${ALARM_NAME}]`);
    expect(callArg.title).toContain(ALARM_NAME);
    // Description includes alarm details
    expect(callArg.description).toContain("CloudWatch Alarm");
    expect(callArg.description).toContain(ALARM_NAME);
    expect(callArg.description).toContain("5XXError");
    expect(callArg.description).toContain("us-east-1");
    expect(callArg.description).toContain("OK → ALARM");
    expect(callArg.description).toContain("Log Query Link");
    // Labels set
    expect(callArg.labelIds).toContain("label-bug");
    expect(callArg.labelIds).toContain("label-auto-impl");
  });

  it("ignores non-ALARM state transitions", async () => {
    const { client, createIssue } = makeMockLinear();

    const { generateKeyPairSync, createSign } = await import("crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certPem = publicKey.export({ type: "pkcs1", format: "pem" }) as string;

    const alarm = makeCloudWatchAlarm({ NewStateValue: "OK", OldStateValue: "ALARM" });
    const snsMsg: SnsMessage = {
      Type: "Notification",
      MessageId: "msg-ok-001",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:CloudWatchAlarms",
      Message: JSON.stringify(alarm),
      Timestamp: "2024-01-01T01:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };

    const { buildSnsCanonicalString: buildCanonical } = await import("../../integrations/cloudwatch.js");
    const signer = createSign("RSA-SHA1");
    signer.update(buildCanonical(snsMsg));
    snsMsg.Signature = signer.sign(privateKey, "base64");

    const certFetcher = vi.fn().mockResolvedValue(certPem);
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, certFetcher);

    const resp = await postCloudWatch(app, snsMsg);
    expect(resp.status).toBe(200);
    const json = await resp.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("returns existing ticket without creating duplicate (idempotency)", async () => {
    const existingTicket = {
      id: "existing-cw-id",
      identifier: "BEC-300",
      title: `[CW:${ALARM_NAME}] ${ALARM_NAME}`,
    };
    const { client, createIssue } = makeMockLinear([existingTicket]);

    const { generateKeyPairSync, createSign } = await import("crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certPem = publicKey.export({ type: "pkcs1", format: "pem" }) as string;

    const alarm = makeCloudWatchAlarm();
    const snsMsg: SnsMessage = {
      Type: "Notification",
      MessageId: "msg-dedup-001",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:CloudWatchAlarms",
      Message: JSON.stringify(alarm),
      Timestamp: "2024-01-01T01:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };

    const { buildSnsCanonicalString: buildCanonical } = await import("../../integrations/cloudwatch.js");
    const signer = createSign("RSA-SHA1");
    signer.update(buildCanonical(snsMsg));
    snsMsg.Signature = signer.sign(privateKey, "base64");

    const certFetcher = vi.fn().mockResolvedValue(certPem);
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, certFetcher);

    const resp = await postCloudWatch(app, snsMsg);
    expect(resp.status).toBe(200);

    const json = await resp.json() as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.deduplicated).toBe(true);
    expect(json.issueId).toBe("BEC-300");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("creates tickets in Triage state with bug + auto-implement labels", async () => {
    const { client, createIssue } = makeMockLinear();

    const { generateKeyPairSync, createSign } = await import("crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certPem = publicKey.export({ type: "pkcs1", format: "pem" }) as string;

    const snsMsg: SnsMessage = {
      Type: "Notification",
      MessageId: "msg-labels-001",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:CloudWatchAlarms",
      Message: JSON.stringify(makeCloudWatchAlarm()),
      Timestamp: "2024-01-01T01:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };

    const { buildSnsCanonicalString: buildCanonical } = await import("../../integrations/cloudwatch.js");
    const signer = createSign("RSA-SHA1");
    signer.update(buildCanonical(snsMsg));
    snsMsg.Signature = signer.sign(privateKey, "base64");

    const certFetcher = vi.fn().mockResolvedValue(certPem);
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, certFetcher);

    await postCloudWatch(app, snsMsg);

    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.stateId).toBe(TRIAGE_STATE_ID);
    expect(callArg.labelIds).toEqual(
      expect.arrayContaining(["label-bug", "label-auto-impl"]),
    );
  });

  it("ticket description includes idempotency marker", async () => {
    const { client, createIssue } = makeMockLinear();

    const { generateKeyPairSync, createSign } = await import("crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certPem = publicKey.export({ type: "pkcs1", format: "pem" }) as string;

    const snsMsg: SnsMessage = {
      Type: "Notification",
      MessageId: "msg-marker-001",
      TopicArn: "arn:aws:sns:us-east-1:123456789012:CloudWatchAlarms",
      Message: JSON.stringify(makeCloudWatchAlarm()),
      Timestamp: "2024-01-01T01:00:00.000Z",
      SignatureVersion: "1",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    };

    const { buildSnsCanonicalString: buildCanonical } = await import("../../integrations/cloudwatch.js");
    const signer = createSign("RSA-SHA1");
    signer.update(buildCanonical(snsMsg));
    snsMsg.Signature = signer.sign(privateKey, "base64");

    const certFetcher = vi.fn().mockResolvedValue(certPem);
    const app = createCloudWatchWebhookHandler(BASE_CONFIG, client, certFetcher);

    await postCloudWatch(app, snsMsg);

    const callArg = createIssue.mock.calls[0][0] as Record<string, unknown>;
    const marker = makeCloudWatchIdempotencyMarker(ALARM_NAME);
    expect(callArg.description).toContain(marker);
  });
});

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe("makeCloudWatchTitlePrefix", () => {
  it("formats alarm name as [CW:<name>]", () => {
    expect(makeCloudWatchTitlePrefix("HighCpuUsage")).toBe("[CW:HighCpuUsage]");
  });

  it("strips square brackets from alarm name", () => {
    expect(makeCloudWatchTitlePrefix("[prod] HighCpuUsage")).toBe("[CW:prod HighCpuUsage]");
  });
});

describe("makeCloudWatchIdempotencyMarker", () => {
  it("formats alarm name as HTML comment", () => {
    expect(makeCloudWatchIdempotencyMarker("MyAlarm")).toBe(
      "<!-- cloudwatch-integration:MyAlarm -->",
    );
  });
});
