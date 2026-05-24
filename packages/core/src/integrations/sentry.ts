// SPDX-License-Identifier: BUSL-1.1
/**
 * Sentry webhook → Linear ticket integration.
 *
 * Receives Sentry "Issue Alert" webhooks and creates Linear tickets in Triage
 * state with bug + auto-implement labels so the PM Agent picks them up
 * autonomously.
 *
 * Operator mental model:
 *   Sentry issue alert fires → urateam creates Linear ticket →
 *   PM Agent triages → autonomous implement pipeline runs
 *
 * Idempotency: tickets are keyed by `[Sentry#<issue-id>]` title prefix so
 * re-fired alerts for the same Sentry issue return the existing ticket within
 * the configurable window instead of creating duplicates.
 *
 * Signature verification: X-Sentry-Hook-Signature HMAC-SHA256 using the
 * Sentry client secret configured in the Sentry webhook settings.
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import { getLinearClient } from "../util/linear.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "SentryIntegration" });

// Linear priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
const SENTRY_LEVEL_TO_PRIORITY: Record<string, number> = {
  critical: 1,
  error: 2,
  warning: 3,
  info: 4,
};

const DEFAULT_TRIAGE_STATE = "Triage";
const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface SentryFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  context_line?: string;
}

export interface SentryStacktrace {
  frames?: SentryFrame[];
}

export interface SentryExceptionValue {
  type?: string;
  value?: string;
  stacktrace?: SentryStacktrace;
}

export interface SentryBreadcrumb {
  timestamp?: string;
  message?: string;
  category?: string;
  level?: string;
}

export interface SentryEvent {
  event_id?: string;
  level?: string;
  exception?: { values?: SentryExceptionValue[] };
  breadcrumbs?: { values?: SentryBreadcrumb[] };
}

export interface SentryIssue {
  id: string;
  url?: string;
  project?: string;
  title?: string;
  level?: string;
  culprit?: string;
  firstSeen?: string;
  lastSeen?: string;
  shortId?: string;
}

export interface SentryWebhookPayload {
  action?: string;
  data?: {
    issue?: SentryIssue;
    event?: SentryEvent;
    triggered_rule?: string;
  };
}

// ---------------------------------------------------------------------------
// Mockable Linear client interface
// ---------------------------------------------------------------------------

/**
 * Minimal Linear API surface needed by the Sentry integration.
 * Implemented by the real LinearClient factory and by test mocks.
 */
export interface SentryLinearClient {
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
 * Configuration for the Sentry webhook integration.
 *
 * @param signingSecret Sentry client secret from the webhook settings page
 * @param linearApiKey Linear Personal API key
 * @param linearTeamId Linear team UUID to create tickets in
 * @param idempotencyWindowMs How long to look back for duplicate tickets (default: 24h)
 * @param triageStateName Linear workflow state name for new tickets (default: "Triage")
 */
export interface SentryIntegrationConfig {
  signingSecret: string;
  linearApiKey: string;
  linearTeamId: string;
  idempotencyWindowMs?: number;
  triageStateName?: string;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the X-Sentry-Hook-Signature header using HMAC-SHA256.
 *
 * @param rawBody Raw request body string
 * @param signature Header value from X-Sentry-Hook-Signature
 * @param secret Sentry client signing secret
 * @returns true if the signature is valid
 */
export function verifySentrySignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const expected = hmac.digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws when buffers differ in length
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

/** Idempotency marker embedded in the Linear ticket description. */
export function makeSentryIdempotencyMarker(issueId: string): string {
  return `<!-- sentry-integration:${issueId} -->`;
}

/** Title prefix used for dedup lookups via Linear title search. */
export function makeSentryTitlePrefix(issueId: string): string {
  return `[Sentry#${issueId}]`;
}

function buildStackTrace(event?: SentryEvent): string {
  const exception = event?.exception?.values?.[0];
  if (!exception) return "_No stack trace available._";

  const frames = exception.stacktrace?.frames ?? [];
  const lines: string[] = [
    `**Exception:** ${exception.type ?? "Error"}: ${exception.value ?? ""}`,
    "",
    "```",
  ];

  // Show last 10 frames (innermost / most relevant)
  for (const frame of frames.slice(-10)) {
    if (frame.filename) {
      lines.push(`  File: ${frame.filename}:${frame.lineno ?? "?"} in ${frame.function ?? "?"}`);
      if (frame.context_line) lines.push(`    ${frame.context_line.trim()}`);
    }
  }
  lines.push("```");
  return lines.join("\n");
}

function buildBreadcrumbs(event?: SentryEvent): string {
  const breadcrumbs = event?.breadcrumbs?.values ?? [];
  if (breadcrumbs.length === 0) return "_No breadcrumbs available._";

  return breadcrumbs
    .slice(-10)
    .map((b) => {
      const time = b.timestamp ? new Date(b.timestamp).toISOString() : "?";
      return `- \`${time}\` [${b.category ?? "?"}] ${b.message ?? ""}`;
    })
    .join("\n");
}

function extractAffectedFiles(event?: SentryEvent): string[] {
  const frames = event?.exception?.values?.[0]?.stacktrace?.frames ?? [];
  const files = new Set<string>();
  for (const frame of frames) {
    // Skip synthetic / built-in entries that start with < (e.g. <frozen ...>)
    if (frame.filename && !frame.filename.startsWith("<")) {
      files.add(frame.filename);
    }
  }
  return [...files];
}

// ---------------------------------------------------------------------------
// Real Linear client factory
// ---------------------------------------------------------------------------

/**
 * Create a SentryLinearClient backed by the real Linear SDK.
 * Returns a thin wrapper over getLinearClient so tests can inject mocks instead.
 *
 * @param apiKey Linear Personal API key
 */
export async function createSentryLinearClient(apiKey: string): Promise<SentryLinearClient> {
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
 * Creates a Hono app handling POST /webhooks/sentry.
 *
 * Verifies X-Sentry-Hook-Signature HMAC-SHA256, parses the Sentry issue alert
 * payload, and creates a Linear ticket in Triage state with bug + auto-implement
 * labels. Idempotent within the configured window.
 *
 * @param config SentryIntegrationConfig with signing secret and Linear credentials
 * @param _linearClient Optional injected Linear client (used in tests; omit in production)
 * @returns Hono app mounting POST /webhooks/sentry
 * @throws Never — all errors are returned as HTTP responses
 */
export function createSentryWebhookHandler(
  config: SentryIntegrationConfig,
  _linearClient?: SentryLinearClient,
): Hono {
  const app = new Hono();
  const idempotencyWindowMs = config.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
  const triageStateName = config.triageStateName ?? DEFAULT_TRIAGE_STATE;

  app.post("/webhooks/sentry", async (c) => {
    const rawBody = await c.req.text();
    // Hono lowercases header names on lookup
    const signature = c.req.header("x-sentry-hook-signature") ?? "";

    if (!verifySentrySignature(rawBody, signature, config.signingSecret)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    let payload: SentryWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as SentryWebhookPayload;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const issue = payload.data?.issue;
    if (!issue?.id) {
      return c.json({ ok: true, message: "No issue data in payload" });
    }

    const linearClient = _linearClient ?? (await createSentryLinearClient(config.linearApiKey));

    // Resolve Triage workflow state
    const statesResp = await linearClient.workflowStates({
      filter: { team: { id: { eq: config.linearTeamId } } },
    });
    const triageState = statesResp.nodes.find((s) => s.name === triageStateName);
    if (!triageState) {
      log.error(
        { triageStateName, teamId: config.linearTeamId },
        "Sentry: triage state not found in Linear team",
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

    // Idempotency: look for an existing ticket for this Sentry issue
    const titlePrefix = makeSentryTitlePrefix(issue.id);
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
        { sentryIssueId: issue.id, linearId: existing.identifier },
        "Sentry: duplicate alert within idempotency window — returning existing ticket",
      );
      return c.json({ ok: true, deduplicated: true, issueId: existing.identifier });
    }

    // Determine priority from Sentry level
    const level = (payload.data?.event?.level ?? issue.level ?? "error").toLowerCase();
    const priority = SENTRY_LEVEL_TO_PRIORITY[level] ?? 2;

    // Build ticket content
    const affectedFiles = extractAffectedFiles(payload.data?.event);
    const marker = makeSentryIdempotencyMarker(issue.id);
    const title = `${titlePrefix} ${issue.title ?? "Sentry error"}`;

    const descriptionParts: string[] = [
      "## Sentry Issue",
      `**ID:** ${issue.shortId ?? issue.id}`,
      `**Level:** ${level}`,
      `**Project:** ${issue.project ?? "unknown"}`,
      `**Culprit:** ${issue.culprit ?? "unknown"}`,
      issue.url ? `**URL:** [View in Sentry](${issue.url})` : "",
      `**First seen:** ${issue.firstSeen ?? "unknown"}`,
      `**Last seen:** ${issue.lastSeen ?? "unknown"}`,
      payload.data?.triggered_rule ? `**Triggered rule:** ${payload.data.triggered_rule}` : "",
      "",
      "## Stack Trace",
      buildStackTrace(payload.data?.event),
      "",
      "## Breadcrumbs (last 10)",
      buildBreadcrumbs(payload.data?.event),
      "",
      "## Affected Files",
      affectedFiles.length > 0
        ? affectedFiles.map((f) => `- \`${f}\``).join("\n")
        : "_No files extracted from stack trace._",
      "",
      "## Recent Deploys",
      "_Deploy information is not included in Sentry issue alert webhooks._",
      "_Check the Sentry releases page for recent deploy context._",
      "",
      "---",
      marker,
    ];

    const description = descriptionParts.filter((l) => l !== "").join("\n");

    const result = await linearClient.createIssue({
      teamId: config.linearTeamId,
      title,
      description,
      stateId: triageState.id,
      labelIds: labelIds.length > 0 ? labelIds : undefined,
      priority,
    });

    if (!result.issue) {
      log.error({ sentryIssueId: issue.id }, "Sentry: Linear createIssue returned no issue");
      return c.json({ error: "Failed to create Linear ticket" }, 500);
    }

    log.info(
      { sentryIssueId: issue.id, linearId: result.issue.identifier },
      "Sentry: created Linear ticket",
    );
    return c.json({ ok: true, issueId: result.issue.identifier });
  });

  return app;
}
