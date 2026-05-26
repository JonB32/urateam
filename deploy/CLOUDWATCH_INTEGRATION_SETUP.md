# CloudWatch Alarms → Linear Integration Setup Guide

## Overview

The CloudWatch integration bridges AWS CloudWatch alarms and Linear via SNS,
enabling a fully autonomous ops/infra investigation workflow:

```
CloudWatch alarm enters ALARM state
        ↓  (SNS publishes to HTTPS endpoint)
Linear ticket created in Triage state (bug + auto-implement labels)
        ↓  (PM Agent triage + autonomous pipeline)
Investigated and resolved via urateam
```

**Operator mental model:**

| System      | Purpose                                                                  |
|-------------|--------------------------------------------------------------------------|
| CloudWatch  | **Inbound** — metric alarms, threshold breaches, anomaly detection       |
| SNS         | **Transport** — delivers alarm state changes to urateam HTTPS endpoint   |
| Linear      | **Triage / work-tracking** — prioritisation, autonomous pipeline routing |

**Out of scope:**
- Paging / on-call rotation. Use PagerDuty or similar for page-grade events;
  urateam handles non-paging-grade ops findings.
- Direct agent invocation bypassing Linear. The Linear-as-state-store pattern
  is intentional — humans can triage before the agent acts.
- OK state transitions. Only `ALARM` state creates tickets; `OK` and
  `INSUFFICIENT_DATA` transitions are silently ignored.

---

## Architecture

```
CloudWatch Alarm (ALARM state)
        ↓
SNS Topic publishes to HTTPS subscription
        ↓  (POST /webhooks/cloudwatch)
packages/core/src/integrations/cloudwatch.ts  — SNS sig verification + ticket creation
        ↓
Linear ticket created in Triage state (bug + auto-implement labels)
        ↓
PM Agent picks up on next tick
```

SNS message types handled:
| Type                     | Action                                         |
|--------------------------|------------------------------------------------|
| `SubscriptionConfirmation` | Fetches `SubscribeURL` to confirm subscription |
| `Notification`           | Verifies signature, creates Linear ticket      |
| Other                    | Ignored with 200 OK                            |

---

## Quick Start

### 1. Configure urateam

Add `cloudwatchIntegration` to your `ServerConfig`:

```typescript
import { createApp } from "@urateam/core";

const { app } = await createApp({
  // ... existing config ...
  cloudwatchIntegration: {
    linearApiKey: process.env.LINEAR_API_KEY!,
    linearTeamId: process.env.LINEAR_TEAM_ID!,
    // Optional: configure idempotency window (default: 24h)
    // idempotencyWindowMs: 24 * 60 * 60 * 1000,
    // Optional: customize Linear state name (default: "Triage")
    // triageStateName: "Triage",
  },
});
```

### 2. Create an SNS Topic

```bash
# Create an SNS topic for CloudWatch alarms
aws sns create-topic --name urateam-cloudwatch-alarms --region us-east-1
# Note the TopicArn in the output: arn:aws:sns:us-east-1:ACCOUNT:urateam-cloudwatch-alarms
```

### 3. Subscribe your urateam HTTPS Endpoint

```bash
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT:urateam-cloudwatch-alarms \
  --protocol https \
  --notification-endpoint https://your-urateam-instance.example.com/webhooks/cloudwatch \
  --region us-east-1
```

AWS sends a `SubscriptionConfirmation` message to the endpoint immediately.
urateam automatically fetches the `SubscribeURL` to confirm the subscription —
no manual step needed.

Verify the subscription is confirmed:
```bash
aws sns list-subscriptions-by-topic \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT:urateam-cloudwatch-alarms \
  --region us-east-1
# SubscriptionArn should show the full ARN (not "PendingConfirmation")
```

### 4. Required AWS IAM Permissions

The AWS identity creating the SNS topic and CloudWatch alarm actions needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sns:CreateTopic",
        "sns:Subscribe",
        "sns:Publish",
        "sns:ListSubscriptionsByTopic"
      ],
      "Resource": "arn:aws:sns:us-east-1:ACCOUNT:urateam-cloudwatch-alarms"
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DescribeAlarms"
      ],
      "Resource": "*"
    }
  ]
}
```

### 5. Wire CloudWatch Alarms to the SNS Topic

**Option A: Console**
1. Go to **CloudWatch → Alarms → Create alarm** (or edit an existing one).
2. Under **Notification**, click **Add notification**.
3. Select **In alarm** → choose your SNS topic.
4. Save the alarm.

**Option B: CLI**
```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "HighErrorRate" \
  --alarm-description "API 5XX error rate above 5%" \
  --metric-name 5XXError \
  --namespace AWS/ApiGateway \
  --statistic Average \
  --period 300 \
  --evaluation-periods 1 \
  --threshold 5.0 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions arn:aws:sns:us-east-1:ACCOUNT:urateam-cloudwatch-alarms \
  --region us-east-1
```

### 6. Verify the Integration

Check urateam logs for:
```
CloudWatch integration mounted at POST /webhooks/cloudwatch
```

To test the alarm manually:
```bash
# Force the alarm into ALARM state
aws cloudwatch set-alarm-state \
  --alarm-name "HighErrorRate" \
  --state-value ALARM \
  --state-reason "Manual test from operator" \
  --region us-east-1
```

A Linear ticket should appear in Triage state within seconds.

Reset after testing:
```bash
aws cloudwatch set-alarm-state \
  --alarm-name "HighErrorRate" \
  --state-value OK \
  --state-reason "Manual reset" \
  --region us-east-1
```

---

## Configuration Reference

| Option                | Type     | Default     | Description                                                         |
|-----------------------|----------|-------------|---------------------------------------------------------------------|
| `linearApiKey`        | `string` | required    | Linear Personal API key                                             |
| `linearTeamId`        | `string` | required    | Linear team UUID to create tickets in                               |
| `idempotencyWindowMs` | `number` | `86400000`  | Milliseconds to look back for duplicate tickets (default: 24h)      |
| `triageStateName`     | `string` | `"Triage"`  | Linear workflow state for new tickets                               |

No CloudWatch-specific credentials are needed — SNS signature verification uses
public certificates fetched from `https://sns.<region>.amazonaws.com/`.

---

## SNS Signature Verification

urateam verifies every SNS `Notification` message cryptographically:

1. Builds the canonical string from the message fields per the
   [AWS SNS signature specification](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).
2. Fetches the signing certificate from `SigningCertURL`
   (URL must be on `*.amazonaws.com`; certificate is cached per URL).
3. Verifies the RSA signature using:
   - `RSA-SHA1` for `SignatureVersion: "1"` (default)
   - `RSA-SHA256` for `SignatureVersion: "2"`

Requests with missing or invalid signatures return `401 Unauthorized`.

**Network requirement:** urateam must be able to reach
`https://sns.<region>.amazonaws.com/` to fetch signing certificates.
If your deployment is behind a proxy or firewall, ensure outbound HTTPS to
`*.amazonaws.com` is allowed.

---

## Ticket Content

Each Linear ticket includes:

- **Alarm name** and optional description
- **AWS account ID** and region
- **State change:** old state → new state with timestamp
- **Metric details:** namespace, metric name, statistic, period, threshold
- **Dimensions:** tagged dimensions (e.g., `ApiName=my-api`)
- **State change reason:** the human-readable reason from CloudWatch
- **Log query link:** CloudWatch Logs Insights URL for the alarm's namespace
- **Idempotency marker:** `<!-- cloudwatch-integration:<alarm-name> -->`

---

## Idempotency

The integration is idempotent within the configured window:

1. On each webhook, the handler searches Linear for a ticket with title starting
   with `[CW:<alarm-name>]` created within `idempotencyWindowMs`.
2. If found, the existing ticket identifier is returned (no new ticket created).
3. If not found, a new ticket is created with the `[CW:<alarm-name>]` prefix.

An alarm that flaps (ALARM → OK → ALARM) within 24 hours creates only one ticket.
After the window expires, a new ALARM transition creates a fresh ticket.

---

## Priority

All CloudWatch ALARM tickets are created with **Linear priority 2 (High)**,
reflecting that an alarm represents an active operational problem.

---

## Linear Requirements

The target Linear team must have:

- A workflow state named `"Triage"` (or the value of `triageStateName`)
- Labels named `"bug"` and `"auto-implement"` (created by PM Agent setup)

---

## Multiple Alarms / Topics

You can configure multiple CloudWatch alarms to publish to the same SNS topic,
or use separate topics per environment:

```bash
# Production alarms
aws sns create-topic --name urateam-alarms-prod
aws sns subscribe --topic-arn ... --protocol https --notification-endpoint .../webhooks/cloudwatch

# Staging alarms (same urateam endpoint, separate Linear team)
aws sns create-topic --name urateam-alarms-staging
```

Each alarm creates its own Linear ticket keyed by alarm name, so concurrent alarms
from different services all get tracked independently.

---

## Local Development

```bash
# Expose local dev server via ngrok
ngrok http 3000

# Subscribe the ngrok URL to your SNS topic
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT:urateam-alarms-dev \
  --protocol https \
  --notification-endpoint https://<ngrok-id>.ngrok.io/webhooks/cloudwatch

# Start urateam
ura dev

# Trigger a test alarm
aws cloudwatch set-alarm-state \
  --alarm-name "TestAlarm" \
  --state-value ALARM \
  --state-reason "Local dev test"
```

---

## Troubleshooting

| Symptom                          | Cause                                          | Fix                                                              |
|----------------------------------|------------------------------------------------|------------------------------------------------------------------|
| `401 Invalid SNS signature`      | SNS cert fetch failed / firewall blocks outbound | Allow outbound HTTPS to `*.amazonaws.com`                     |
| `401 Invalid SNS signature`      | Message was tampered in transit                | Check SNS topic policies; ensure no middlebox is modifying bodies |
| Subscription stays `PendingConfirmation` | urateam can't reach the SubscribeURL   | Check firewall; confirm `/webhooks/cloudwatch` returns 200       |
| No ticket for ALARM state        | Alarm in `OK` or `INSUFFICIENT_DATA` state     | Only `ALARM` state transitions create tickets — by design        |
| `Triage state not found`         | State name mismatch                            | Check `triageStateName` or create "Triage" state in Linear       |
| Duplicate tickets                | `idempotencyWindowMs` too short                | Increase the window; default 24h covers most flapping alarms      |
