// SPDX-License-Identifier: BUSL-1.1
/**
 * AWS CloudWatch alarm → Linear ticket integration via SNS.
 *
 * Receives CloudWatch alarm state-change notifications delivered via AWS SNS
 * to an HTTPS endpoint and creates Linear tickets in Triage state with
 * bug + auto-implement labels so the PM Agent picks them up autonomously.
 *
 * Operator mental model:
 *   CloudWatch alarm → ALARM state → SNS publishes to this endpoint →
 *   urateam creates Linear ticket → PM Agent triages →
 *   autonomous implement pipeline runs
 *
 * SNS message types handled:
 *   - SubscriptionConfirmation: fetches SubscribeURL to confirm the subscription
 *   - Notification: verifies signature, parses CloudWatch alarm, creates ticket
 *   - Other: ignored with 200 OK
 *
 * Signature verification: RSA-SHA1 (SignatureVersion 1) or RSA-SHA256 (v2)
 * using the certificate at SigningCertURL (must be on amazonaws.com).
 *
 * Idempotency: tickets are keyed by `[CW:<alarm-name>]` title prefix so
 * repeated ALARM transitions within the configurable window return the
 * existing ticket instead of creating duplicates.
 */

import { Hono } from "hono";
import { createVerify } from "crypto";
import { getLinearClient } from "../util/linear.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "CloudWatchIntegration" });

const DEFAULT_TRIAGE_STATE = "Triage";
const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// SNS / CloudWatch types
// ---------------------------------------------------------------------------

/** AWS SNS message envelope (both Notification and SubscriptionConfirmation). */
export interface SnsMessage {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

/** CloudWatch alarm state-change message (parsed from SnsMessage.Message). */
export interface CloudWatchAlarmMessage {
  AlarmName?: string;
  AlarmDescription?: string;
  AWSAccountId?: string;
  NewStateValue?: string;
  NewStateReason?: string;
  OldStateValue?: string;
  StateChangeTime?: string;
  Region?: string;
  AlarmArn?: string;
  Trigger?: {
    MetricName?: string;
    Namespace?: string;
    StatisticType?: string;
    Statistic?: string;
    Unit?: string | null;
    Period?: number;
    EvaluationPeriods?: number;
    DatapointsToAlarm?: number;
    ComparisonOperator?: string;
    Threshold?: number;
    Dimensions?: Array<{ name?: string; value?: string }>;
  };
}

// ---------------------------------------------------------------------------
// Certificate fetching (injectable for tests)
// ---------------------------------------------------------------------------

/** Fetches a PEM certificate from a URL. Injectable for test isolation. */
export type CertFetcher = (url: string) => Promise<string>;

// Module-level cache so we don't re-fetch the same cert on every request.
const _certCache = new Map<string, string>();

/**
 * Default certificate fetcher for production use.
 * Validates the URL is on amazonaws.com before fetching; caches results.
 *
 * @param url SigningCertURL from the SNS message
 * @returns PEM certificate string
 * @throws Error if the URL hostname is not on amazonaws.com or the fetch fails
 */
export async function defaultCertFetcher(url: string): Promise<string> {
  const parsed = new URL(url);
  if (!parsed.hostname.endsWith(".amazonaws.com")) {
    throw new Error(
      `SNS SigningCertURL must be on amazonaws.com, got: ${parsed.hostname}`,
    );
  }
  const cached = _certCache.get(url);
  if (cached) return cached;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch SNS signing cert: HTTP ${resp.status} from ${url}`);
  }
  const cert = await resp.text();
  _certCache.set(url, cert);
  return cert;
}

/** Clear the certificate cache (for tests only). */
export function _clearCertCache(): void {
  _certCache.clear();
}

// ---------------------------------------------------------------------------
// SNS signature verification
// ---------------------------------------------------------------------------

/**
 * Build the canonical string for SNS signature verification per AWS spec.
 * Fields are included in alphabetical order as `Name\nValue\n` pairs.
 *
 * @param msg Parsed SNS message
 * @returns Canonical string to verify against the Signature field
 */
export function buildSnsCanonicalString(msg: SnsMessage): string {
  // Fields vary by message type per AWS documentation
  const isConfirmation =
    msg.Type === "SubscriptionConfirmation" || msg.Type === "UnsubscribeConfirmation";

  const candidates: Array<[string, string | undefined]> = [
    ["Message", msg.Message],
    ["MessageId", msg.MessageId],
    // Subject is optional — only include when present
    ["Subject", msg.Subject],
    ["SubscribeURL", isConfirmation ? msg.SubscribeURL : undefined],
    ["Timestamp", msg.Timestamp],
    ["Token", isConfirmation ? msg.Token : undefined],
    ["TopicArn", msg.TopicArn],
    ["Type", msg.Type],
  ];

  return candidates
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}\n${value}\n`)
    .join("");
}

/**
 * Verify an SNS message signature using the AWS-specified RSA algorithm.
 *
 * @param msg Parsed SNS message object
 * @param certFetcher Injectable cert fetcher (defaults to defaultCertFetcher)
 * @returns true if the signature is cryptographically valid
 * @throws Error if the cert fetch fails
 */
export async function verifySnsSignature(
  msg: SnsMessage,
  certFetcher: CertFetcher = defaultCertFetcher,
): Promise<boolean> {
  if (!msg.SigningCertURL || !msg.Signature || !msg.SignatureVersion) {
    return false;
  }

  const canonicalString = buildSnsCanonicalString(msg);
  const cert = await certFetcher(msg.SigningCertURL);

  // SignatureVersion 1 → RSA-SHA1, SignatureVersion 2 → RSA-SHA256
  const algorithm = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonicalString);
    return verifier.verify(cert, msg.Signature, "base64");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mockable Linear client
// ---------------------------------------------------------------------------

/**
 * Minimal Linear API surface needed by the CloudWatch integration.
 * Implemented by the real LinearClient factory and by test mocks.
 */
export interface CloudWatchLinearClient {
  issues(args: { filter: object; first?: number }): Promise<{ nodes: Array<{ id: string; identifier: string; title: string }> }>;
  workflowStates(args: { filter: object }): Promise<{ nodes: Array<{ id: string; name: string }> }>;
  issueLabels(args: { filter: object; first?: number }): Promise<{ nodes: Array<{ id: string; name: string }> }>;
  createIssue(input: {
    teamId: string;
    title: string;
    description: string;
    stateId: string;
    labelIds?: string[];
    priority?: number;
  }): Promise<{ issue?: { id: string; identifier: string } | null }>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the CloudWatch alarm → Linear ticket integration.
 *
 * @param linearApiKey Linear Personal API key
 * @param linearTeamId Linear team UUID to create tickets in
 * @param idempotencyWindowMs How long to look back for duplicate tickets (default: 24h)
 * @param triageStateName Linear workflow state name for new tickets (default: "Triage")
 */
export interface CloudWatchIntegrationConfig {
  linearApiKey: string;
  linearTeamId: string;
  idempotencyWindowMs?: number;
  triageStateName?: string;
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

/** Idempotency marker embedded in the Linear ticket description. */
export function makeCloudWatchIdempotencyMarker(alarmName: string): string {
  return `<!-- cloudwatch-integration:${alarmName} -->`;
}

/** Title prefix for dedup lookups; brackets stripped from alarm name to avoid Linear search issues. */
export function makeCloudWatchTitlePrefix(alarmName: string): string {
  const sanitized = alarmName.replace(/[[\]]/g, "");
  return `[CW:${sanitized}]`;
}

function buildCloudWatchDescription(
  alarm: CloudWatchAlarmMessage,
  snsMsg: SnsMessage,
): string {
  const trigger = alarm.Trigger;
  const region = alarm.Region ?? "";
  const alarmName = alarm.AlarmName ?? "unknown";

  // Build a CloudWatch Logs Insights link when we have enough info
  let logQueryLink = "_Region not available — check CloudWatch console manually._";
  if (region && trigger?.Namespace) {
    const encodedSource = encodeURIComponent(trigger.Namespace);
    logQueryLink =
      `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}` +
      `#logsV2:logs-insights$3FqueryDetail$3D~(source~(~'${encodedSource}))`;
  }

  const dimensionStr =
    trigger?.Dimensions && trigger.Dimensions.length > 0
      ? trigger.Dimensions.map((d) => `${d.name ?? "?"}=${d.value ?? "?"}`).join(", ")
      : "";

  const metricParts: string[] = [
    trigger?.Namespace && trigger.MetricName
      ? `**Metric:** ${trigger.Namespace}/${trigger.MetricName}`
      : "",
    trigger?.Statistic
      ? `**Statistic:** ${trigger.Statistic}`
      : trigger?.StatisticType
        ? `**Statistic type:** ${trigger.StatisticType}`
        : "",
    trigger?.Unit ? `**Unit:** ${trigger.Unit}` : "",
    trigger?.Period !== undefined ? `**Period:** ${trigger.Period}s` : "",
    trigger?.EvaluationPeriods !== undefined
      ? `**Evaluation periods:** ${trigger.EvaluationPeriods}`
      : "",
    trigger?.ComparisonOperator !== undefined && trigger.Threshold !== undefined
      ? `**Threshold:** ${trigger.ComparisonOperator} ${trigger.Threshold}`
      : "",
    dimensionStr ? `**Dimensions:** ${dimensionStr}` : "",
  ].filter(Boolean);

  const marker = makeCloudWatchIdempotencyMarker(alarmName);

  const parts: string[] = [
    "## CloudWatch Alarm",
    `**Alarm:** ${alarmName}`,
    alarm.AlarmDescription ? `**Description:** ${alarm.AlarmDescription}` : "",
    `**Account:** ${alarm.AWSAccountId ?? "unknown"}`,
    `**Region:** ${region || "unknown"}`,
    `**State change:** ${alarm.OldStateValue ?? "?"} → ${alarm.NewStateValue ?? "?"}`,
    `**Time:** ${alarm.StateChangeTime ?? snsMsg.Timestamp ?? "unknown"}`,
    alarm.AlarmArn ? `**ARN:** \`${alarm.AlarmArn}\`` : "",
    "",
    "## Metric Details",
    metricParts.length > 0 ? metricParts.join("\n") : "_No trigger details available._",
    "",
    "## State Change Reason",
    alarm.NewStateReason ?? "_No reason provided._",
    "",
    "## Log Query Link",
    logQueryLink,
    "",
    "---",
    marker,
  ];

  return parts.filter((l) => l !== "").join("\n");
}

// ---------------------------------------------------------------------------
// Real Linear client factory
// ---------------------------------------------------------------------------

/**
 * Create a CloudWatchLinearClient backed by the real Linear SDK.
 *
 * @param apiKey Linear Personal API key
 */
export async function createCloudWatchLinearClient(apiKey: string): Promise<CloudWatchLinearClient> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (await getLinearClient(apiKey)) as any;
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async issues(args) { return client.issues(args); },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async workflowStates(args) { return client.workflowStates(args); },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async issueLabels(args) { return client.issueLabels(args); },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async createIssue(input) { return client.createIssue(input); },
  };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a Hono app handling POST /webhooks/cloudwatch.
 *
 * Handles three SNS message types:
 * - SubscriptionConfirmation: confirms the SNS subscription automatically
 * - Notification: verifies signature, parses CloudWatch alarm, creates Linear ticket
 * - Other: returns 200 OK and ignores
 *
 * Only ALARM state transitions create Linear tickets; OK/INSUFFICIENT_DATA
 * transitions are silently ignored.
 *
 * @param config CloudWatchIntegrationConfig with Linear credentials
 * @param _linearClient Optional injected Linear client (used in tests; omit in production)
 * @param _certFetcher Optional injected cert fetcher (used in tests; omit in production)
 * @returns Hono app mounting POST /webhooks/cloudwatch
 * @throws Never — all errors are returned as HTTP responses
 */
export function createCloudWatchWebhookHandler(
  config: CloudWatchIntegrationConfig,
  _linearClient?: CloudWatchLinearClient,
  _certFetcher?: CertFetcher,
): Hono {
  const app = new Hono();
  const idempotencyWindowMs = config.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
  const triageStateName = config.triageStateName ?? DEFAULT_TRIAGE_STATE;

  app.post("/webhooks/cloudwatch", async (c) => {
    const rawBody = await c.req.text();

    let snsMsg: SnsMessage;
    try {
      snsMsg = JSON.parse(rawBody) as SnsMessage;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Handle SNS subscription confirmation automatically
    if (snsMsg.Type === "SubscriptionConfirmation") {
      if (snsMsg.SubscribeURL) {
        try {
          await fetch(snsMsg.SubscribeURL);
          log.info(
            { topicArn: snsMsg.TopicArn },
            "CloudWatch: SNS subscription confirmed",
          );
        } catch (err) {
          log.error({ err }, "CloudWatch: failed to confirm SNS subscription");
        }
      }
      return c.json({ ok: true, message: "Subscription confirmed" });
    }

    if (snsMsg.Type !== "Notification") {
      return c.json({ ok: true, message: "Non-notification SNS message ignored" });
    }

    // Verify SNS signature
    const certFetcher = _certFetcher ?? defaultCertFetcher;
    try {
      const isValid = await verifySnsSignature(snsMsg, certFetcher);
      if (!isValid) {
        return c.json({ error: "Invalid SNS signature" }, 401);
      }
    } catch (err) {
      log.error({ err }, "CloudWatch: SNS signature verification error");
      return c.json({ error: "Signature verification failed" }, 401);
    }

    // Parse CloudWatch alarm message from SNS Message field
    let alarm: CloudWatchAlarmMessage;
    try {
      alarm = JSON.parse(snsMsg.Message ?? "{}") as CloudWatchAlarmMessage;
    } catch {
      return c.json({ error: "Invalid CloudWatch alarm JSON in SNS Message" }, 400);
    }

    // Only create tickets for ALARM transitions (not OK or INSUFFICIENT_DATA)
    if (alarm.NewStateValue !== "ALARM") {
      return c.json({
        ok: true,
        message: `Ignoring ${alarm.NewStateValue ?? "unknown"} state — only ALARM creates tickets`,
      });
    }

    const alarmName = alarm.AlarmName;
    if (!alarmName) {
      return c.json({ ok: true, message: "No alarm name in payload" });
    }

    const linearClient =
      _linearClient ?? (await createCloudWatchLinearClient(config.linearApiKey));

    // Resolve Triage workflow state
    const statesResp = await linearClient.workflowStates({
      filter: { team: { id: { eq: config.linearTeamId } } },
    });
    const triageState = statesResp.nodes.find((s) => s.name === triageStateName);
    if (!triageState) {
      log.error(
        { triageStateName, teamId: config.linearTeamId },
        "CloudWatch: triage state not found in Linear team",
      );
      return c.json({ error: "Triage state not found" }, 500);
    }

    // Resolve bug + auto-implement label IDs
    const labelsResp = await linearClient.issueLabels({
      filter: { team: { id: { eq: config.linearTeamId } } },
      first: 100,
    });
    const bugLabel = labelsResp.nodes.find((l) => l.name === "bug");
    const autoImplLabel = labelsResp.nodes.find((l) => l.name === "auto-implement");
    const labelIds = [bugLabel?.id, autoImplLabel?.id].filter((id): id is string => !!id);

    // Idempotency: look for an existing ticket for this alarm within the window
    const titlePrefix = makeCloudWatchTitlePrefix(alarmName);
    const windowStart = new Date(Date.now() - idempotencyWindowMs);
    const existingResp = await linearClient.issues({
      filter: {
        team: { id: { eq: config.linearTeamId } },
        title: { startsWith: titlePrefix },
        createdAt: { gte: windowStart.toISOString() },
      },
      first: 1,
    });
    if (existingResp.nodes.length > 0) {
      const existing = existingResp.nodes[0]!;
      log.info(
        { alarmName, linearId: existing.identifier },
        "CloudWatch: duplicate alarm within idempotency window — returning existing ticket",
      );
      return c.json({ ok: true, deduplicated: true, issueId: existing.identifier });
    }

    // Build and create the Linear ticket
    const title = `${titlePrefix} ${alarmName}`;
    const description = buildCloudWatchDescription(alarm, snsMsg);

    const result = await linearClient.createIssue({
      teamId: config.linearTeamId,
      title,
      description,
      stateId: triageState.id,
      labelIds: labelIds.length > 0 ? labelIds : undefined,
      priority: 2, // High — alarm state indicates an active problem
    });

    if (!result.issue) {
      log.error({ alarmName }, "CloudWatch: Linear createIssue returned no issue");
      return c.json({ error: "Failed to create Linear ticket" }, 500);
    }

    log.info(
      { alarmName, linearId: result.issue.identifier },
      "CloudWatch: created Linear ticket",
    );
    return c.json({ ok: true, issueId: result.issue.identifier });
  });

  return app;
}
