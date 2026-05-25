# Sentry → Linear Integration Setup Guide

## Overview

The Sentry integration bridges Sentry issue alerts and Linear, enabling a fully
autonomous investigation and fix workflow:

```
Sentry issue alert fires
        ↓  (webhook to urateam)
Linear ticket created in Triage state (bug + auto-implement labels)
        ↓  (PM Agent triage + autonomous pipeline)
Implemented, reviewed, and closed via urateam
```

**Operator mental model:**

| System   | Purpose                                                                  |
|----------|--------------------------------------------------------------------------|
| Sentry   | **Inbound** — error events, issue alerts, stack traces                   |
| Linear   | **Triage / work-tracking** — prioritisation, autonomous pipeline routing |

**Out of scope:** Direct agent invocation bypassing Linear. The Linear-as-state-store
pattern is intentional — humans can triage, deprioritise, or cancel before the
agent picks up the ticket.

---

## Architecture

```
Sentry issue alert webhook
        ↓  (POST /webhooks/sentry)
packages/core/src/integrations/sentry.ts  — handler + HMAC verification
        ↓
Linear ticket created in Triage state (bug + auto-implement labels)
        ↓
PM Agent picks up on next tick
```

---

## Quick Start

### 1. Configure urateam

Add `sentryIntegration` to your `ServerConfig` (in `ura.config.ts` or equivalent):

```typescript
import { createApp } from "@urateam/core";

const { app } = await createApp({
  // ... existing config ...
  sentryIntegration: {
    signingSecret: process.env.SENTRY_SIGNING_SECRET!,
    linearApiKey: process.env.LINEAR_API_KEY!,
    linearTeamId: process.env.LINEAR_TEAM_ID!,
    // Optional: configure idempotency window (default: 24h)
    // idempotencyWindowMs: 24 * 60 * 60 * 1000,
    // Optional: customize Linear state name (default: "Triage")
    // triageStateName: "Triage",
  },
});
```

Or via environment variables in `ura start` / `ura dev` — add to your `.env` file:

```bash
SENTRY_SIGNING_SECRET=your-sentry-client-secret
# LINEAR_API_KEY and LINEAR_TEAM_ID are already required for the core pipeline
```

### 2. Create a Sentry Webhook

1. Go to **Sentry → Settings → Developer Settings → Internal Integrations**.
2. Click **Create New Integration**.
3. Name it (e.g., "urateam").
4. Under **Webhook**, enable **Issue** events.
5. Set the **Webhook URL** to your urateam instance:
   ```
   https://your-urateam-instance.example.com/webhooks/sentry
   ```
6. Copy the **Client Secret** — this is your `SENTRY_SIGNING_SECRET`.
7. Save the integration.

Alternatively, use **Alert Rules** integration:
1. Go to **Settings → Integrations → Webhook**.
2. Add a webhook pointing to `/webhooks/sentry` with the signing secret.

### 3. Configure Alert Rules (Required)

The integration only fires when a Sentry **Issue Alert** triggers. Create an alert rule:

1. Go to your Sentry project → **Alerts → Create Alert → Issue Alert**.
2. Set conditions (e.g., "When an issue is seen more than 10 times in 1 hour").
3. Set the action to **Send a notification via webhook** (or "Send a notification via an
   integration" → select your Internal Integration from step 2).
4. Save the alert rule.

### 4. Verify the Integration

Check urateam logs for:
```
Sentry integration mounted at POST /webhooks/sentry
```

Trigger a test alert in Sentry (or use the "Send Test Event" in the webhook settings).
You should see a new Linear ticket appear in Triage state within seconds.

---

## Configuration Reference

| Option                | Type     | Default     | Description                                           |
|-----------------------|----------|-------------|-------------------------------------------------------|
| `signingSecret`       | `string` | required    | Sentry client secret from the webhook settings        |
| `linearApiKey`        | `string` | required    | Linear Personal API key                               |
| `linearTeamId`        | `string` | required    | Linear team UUID to create tickets in                 |
| `idempotencyWindowMs` | `number` | `86400000`  | Milliseconds to look back for duplicate tickets (24h) |
| `triageStateName`     | `string` | `"Triage"`  | Linear workflow state for new tickets                 |

---

## Priority Mapping

Sentry error level maps to Linear priority:

| Sentry Level | Linear Priority |
|--------------|-----------------|
| `critical`   | 1 — Urgent      |
| `error`      | 2 — High        |
| `warning`    | 3 — Medium      |
| `info`       | 4 — Low         |

---

## Ticket Content

Each Linear ticket created by the Sentry integration includes:

- **Issue metadata:** Sentry ID, project, level, culprit, first/last seen timestamps
- **Stack trace:** Last 10 frames from the exception, with file, line, and context
- **Breadcrumbs:** Last 10 breadcrumbs before the event
- **Affected files:** Unique filenames extracted from the stack trace
- **Triggered rule:** The Sentry alert rule that fired
- **Idempotency marker:** HTML comment `<!-- sentry-integration:<id> -->` for dedup

---

## Idempotency

The integration is idempotent within the configured window:

1. On each webhook, the handler searches Linear for an existing ticket with title
   starting with `[Sentry#<issue-id>]` created within `idempotencyWindowMs`.
2. If found, the existing ticket identifier is returned and no new ticket is created.
3. If not found, a new ticket is created with the `[Sentry#<id>]` title prefix.

Re-fired alerts for the same Sentry issue within 24 hours create exactly one Linear ticket.
After the window expires, a new alert creates a fresh ticket.

---

## Signature Verification

All incoming requests are verified using HMAC-SHA256:

- **Header:** `X-Sentry-Hook-Signature`
- **Algorithm:** HMAC-SHA256
- **Key:** Your Sentry client secret (`signingSecret`)
- **Body:** Raw request body

Requests with missing or invalid signatures return `401 Unauthorized`.

---

## Linear Requirements

The target Linear team must have:

- A workflow state named `"Triage"` (or the value of `triageStateName`)
- Labels named `"bug"` and `"auto-implement"` (created by PM Agent setup)

If labels are not found, the ticket is created without them (PM Agent will add them
during triage).

---

## Local Development

```bash
# Expose your local dev server via ngrok
ngrok http 3000

# Set the ngrok URL as the Sentry webhook URL
# Configure your .env
SENTRY_SIGNING_SECRET=your-client-secret

# Start urateam
ura dev

# Send a test webhook from Sentry Settings → Developer Settings →
# your integration → "Send Test Event"
```

---

## Troubleshooting

| Symptom                           | Cause                                   | Fix                                                     |
|-----------------------------------|-----------------------------------------|---------------------------------------------------------|
| `401 Unauthorized`                | Wrong signing secret                    | Check `SENTRY_SIGNING_SECRET` matches Sentry client secret |
| No ticket created, 200 returned   | Payload has no `data.issue.id`          | Ensure alert rule is set to "Issue Alert" type          |
| `Triage state not found`          | State name mismatch                     | Check `triageStateName` or create "Triage" state in Linear |
| Duplicate tickets                 | `idempotencyWindowMs` too short         | Increase the window; default 24h covers most alert floods |
| Ticket missing labels             | Labels don't exist in Linear team       | Create "bug" and "auto-implement" labels in your Linear team |
