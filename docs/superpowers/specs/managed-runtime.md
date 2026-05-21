# Design: urateam Managed Runtime Tier

**Date**: 2026-05-12
**Status**: Draft — pending BEC-132 monetization decision
**Issue**: BEC-202
**Scope**: Architectural decisions and MVP design for a middle deployment tier — customer-hosted agent runtime with a cloud networking and services layer operated by urateam. Unblocks onboarding friction reduction without the full investment cost of a hosted SaaS product.

---

## 1. Background and motivation

urateam currently supports one deployment model: full self-hosting. Operators must:

- Register a GitHub App, configure secrets, set up Caddy/Cloudflare for inbound webhook URLs
- Configure Linear webhook endpoints with a stable public IP or tunnel
- Manage SSL/TLS termination and reverse-proxy setup

This is 2–4 hours of friction before the first pipeline run. Competitive analysis (2026-05-11) shows Cyrus offers a middle tier where code stays on the customer's infrastructure but networking/auth bootstrap is hosted. This document specifies a comparable middle tier for urateam.

**What stays on the customer's box:** agent process, SQLite/Postgres DB, git worktrees, code, Claude/OpenRouter API keys, ANTHROPIC_API_KEY.

**What the hosted layer provides:**
- A managed inbound webhook receiver with a stable per-customer URL (eliminates public-IP/DNS requirement)
- A managed GitHub App with per-customer installation (eliminates operator App registration)
- A centralized license validation endpoint (optional, for real-time revocation in Phase 2)
- Optional managed Slack app (same pattern as GitHub App)

### Non-goals for Phase 1

- Hosted agent execution (no cloud sandbox, no cloud DB)
- Real-time log streaming to the hosted layer
- Proprietary protocol (all forwarding uses HTTPS + standard webhooks)
- Automated billing integration (manual SKU until BEC-132 decides monetization model)

---

## 2. Architectural decisions

### Decision 1 — Inbound networking model

**Chosen approach: stable per-customer HTTPS endpoint with runtime-initiated long-poll (reverse-proxy tunnel)**

The hosted layer exposes `https://webhooks.urateams.com/c/{customer-id}/linear` and `.../github`. When the customer's runtime starts, it opens a persistent authenticated connection to the hosted layer (long-poll or SSE channel). Incoming webhooks are enqueued server-side and delivered over this channel to the runtime within ~500 ms.

```
┌─ Linear ──────────┐         ┌─ Hosted Layer (webhooks.urateams.com) ─────────────┐
│                   │ HTTPS   │                                                     │
│  POST /c/{id}/    ├────────►│  Webhook Receiver → Queue (per-customer channel)   │
│  linear           │         │                          │                          │
└───────────────────┘         │                          │ SSE/long-poll push       │
                              └──────────────────────────┼──────────────────────────┘
┌─ GitHub ──────────┐                                    │
│                   │ HTTPS   ┌──────────────────────────▼──────────────────────────┐
│  POST /c/{id}/    ├────────►│                                                     │
│  github           │         │  Customer Runtime (their infra)                     │
└───────────────────┘         │  ┌─────────────────────────────────────────────┐   │
                              │  │ Tunnel client (managed-runtime-client.ts)   │   │
                              │  │  - authenticates with hosted layer JWT       │   │
                              │  │  - receives forwarded webhooks               │   │
                              │  │  - calls localhost webhook handler           │   │
                              │  └─────────────────────────────────────────────┘   │
                              └─────────────────────────────────────────────────────┘
```

**Why this over alternatives:**

| Option | Pro | Con | Decision |
|---|---|---|---|
| **Long-poll tunnel (chosen)** | No NAT traversal, no port opens, works behind corporate firewalls. Runtime initiates outbound only. | Hosted layer must handle persistent connections (Cloudflare Durable Objects or Fly.io handles this well). | ✅ Chosen |
| Stable per-customer URL + customer-operated reverse proxy (Cloudflare Tunnel, ngrok) | Customer fully controls proxy | Still requires customer tunnel setup — doesn't reduce friction | ❌ Same friction |
| mTLS/WebSocket tunnel (Cloudflare Tunnel style) | Fully encrypted bidirectional | Higher operational complexity, TLS client cert provisioning | Deferred to Phase 2 if SSE proves unreliable |
| Polling by runtime (runtime calls hosted API for events) | Simplest hosted layer | Higher latency (5-30s), poor UX for webhook-driven workflows | ❌ Too slow |

**Implementation note:** The SSE channel MUST include per-message HMAC verification (signed with the customer's runtime secret) so a compromised hosted layer cannot inject malicious webhook payloads into the runtime. This is the primary security boundary.

---

### Decision 2 — Runtime-to-hosted-layer authentication

**Chosen approach: Ed25519 JWT (same pattern as license key) + per-customer runtime secret**

At enrollment, the hosted layer generates two artifacts:

1. **Runtime JWT** (`URATEAM_MANAGED_RT_TOKEN`): short-lived (24h) EdDSA JWT issued by the hosted layer's signing key. Claims: `sub` = customer ID, `iss` = `"urateams.com"`, `tier` = `"managed-runtime"`, `exp`. Renewed automatically by the tunnel client before expiry. The runtime uses this to authenticate the SSE channel (HTTP Bearer header).

2. **Webhook signing secret** (`URATEAM_MANAGED_RT_WEBHOOK_SECRET`): 32-byte random secret, never transmitted to the hosted layer after enrollment. The customer's runtime signs every webhook ACK and uses it to verify forwarded payloads (HMAC-SHA256, same pattern as Linear's own webhook signatures). The hosted layer stores only the `HMAC(secret, customer-id)` hash, not the secret itself.

**Why not mTLS:** mTLS requires certificate provisioning infrastructure (CA, cert rotation). The JWT + HMAC-of-secret pattern reuses our existing Ed25519 infrastructure (same public key embedded at build time in `license-public-key.ts`). The hosted layer's Runtime CA can be a single Ed25519 keypair stored in Cloudflare KV/Fly secrets.

**Enrollment flow:**

```
1. Operator runs: ura managed-runtime enroll --email admin@company.com
2. CLI POSTs to https://api.urateams.com/v1/managed-runtime/enroll
   { email, customerId (from license JWT), publicKey (generated locally) }
3. Hosted layer:
   a. Validates the license JWT (customerId must have managed-runtime tier)
   b. Generates customer channel ID
   c. Returns: { runtimeToken (24h JWT), webhookSecret (32-byte hex) }
4. CLI writes to .env:
   URATEAM_MANAGED_RT_TOKEN=<jwt>
   URATEAM_MANAGED_RT_WEBHOOK_SECRET=<hex>
   URATEAM_MANAGED_RT_CUSTOMER_ID=<customer-id>
5. On next startup, runtime detects URATEAM_MANAGED_RT_TOKEN and starts the tunnel client
```

**Credential isolation guarantee:** The hosted layer never stores `URATEAM_ANTHROPIC_API_KEY`, `URATEAM_LINEAR_API_KEY`, `URATEAM_GITHUB_*`, or any agent-execution secrets. Those stay exclusively on the customer's box.

---

### Decision 3 — GitHub App multi-tenancy model

**Chosen approach: single shared GitHub App with per-customer installation routing**

urateam operates one GitHub App (`urateam-bot`, owned by the `urateams` GitHub org). Customers install this App on their GitHub org/repos via a standard GitHub OAuth flow, which creates an **installation ID** scoped to that customer's org.

```
Customer GitHub Org
  └── Installs "urateam-bot" App → GitHub creates installation_id: 12345
        └── Webhooks route to: webhooks.urateams.com/c/{customer-id}/github
        └── Hosted layer maps installation_id → customer_id in routing table
        └── Forwarded to customer runtime over SSE channel
```

**Installation routing:** GitHub sends the `installation.id` in every webhook payload. The hosted layer maintains an `installations` table: `(installation_id, customer_id, created_at)`. On webhook receipt, the hosted layer resolves `customer_id` from `installation_id` and routes to that customer's SSE channel.

**App token generation:** The hosted layer's GitHub App authenticates with an installation token (via `POST /app/installations/{id}/access_tokens`). This token is **never exposed to the customer's runtime**. Instead, the hosted layer forwards the raw webhook payload (with HMAC verification), and the customer's runtime uses its own Octokit instance with a traditional `GITHUB_TOKEN` / `GITHUB_APP_PRIVATE_KEY` for PR creation, branch pushes, and other read/write operations.

**Why shared App over per-customer App:**

| Option | Pro | Con |
|---|---|---|
| **Shared App (chosen)** | Zero setup for customer. Single install click. Hosted layer manages App credentials. | urateams must operate the App; a bug in the routing table could mis-route webhooks. |
| Per-customer OAuth-authorized App instances | Customer controls their own App credentials | Requires each customer to register a GitHub App — same friction as today. Defeats the purpose. |

**Security implication:** The `installation_id` → `customer_id` mapping is security-critical. A mis-routing bug would forward one customer's GitHub events to another customer's runtime. Mitigation: the HMAC-signed payload (Decision 2) means that even if forwarded to the wrong SSE channel, the receiving runtime will reject it (wrong HMAC key). The double-signature layer (GitHub's own webhook secret + our HMAC) provides defense in depth.

**Operational:** The shared App's private key is stored in the hosted layer's secrets manager (Cloudflare Workers Secrets or Fly.io secrets). Key rotation follows the existing `docs/` pattern.

**Per-customer App path remains available:** Operators who want to manage their own GitHub App (for compliance or institutional reasons) set `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` as today. The managed-runtime tunnel client only handles inbound webhook forwarding; outbound GitHub API calls are always made from the customer's runtime using whatever credentials are configured there.

---

### Decision 4 — License tier mapping

**New tier: `managed-runtime` (between `pro` and `enterprise`)**

Updated tier ladder:

| Tier | Deployment model | Key features beyond OSS | Target buyer |
|---|---|---|---|
| `oss` | Full self-host | Core pipeline only | Individual devs, open-source contributors |
| `pro` | Full self-host | Conflict detection, deep review, multi-repo, release manager, Slack interface, stage models | Small/medium teams (5-50 eng) |
| **`managed-runtime`** | **Self-host runtime + hosted networking** | All Pro features + managed webhook ingress + managed GH App + license telemetry opt-in | Teams that want Pro features without infrastructure setup |
| `enterprise` | Full self-host (or managed-runtime) | All Pro + SSO, audit log, RBAC, spend caps, org policy, cost dashboard | 50-500 eng orgs with compliance requirements |

**License JWT additions:**

```typescript
// packages/core/src/license.ts — additions
export const MANAGED_RUNTIME_FEATURES: LicenseFeature[] = [
  ...PRO_FEATURES,
  "managed-runtime-networking",   // enables tunnel client at startup
  "managed-telemetry",            // enables opt-in metrics reporting
];

// Tier resolution
case "managed-runtime":
  features = new Set(MANAGED_RUNTIME_FEATURES);
  break;
```

**`managed-runtime-networking` feature gate:** the tunnel client in `packages/core/src/managed-runtime/tunnel-client.ts` calls `isFeatureLicensed("managed-runtime-networking")` at startup. If unlicensed, a warning is logged and the feature is skipped — the runtime falls back to direct webhook handling (standard self-host mode).

**Pricing note (BEC-132 dependent):** No pricing is specified in this spec. BEC-132 resolves the monetization model. This tier's existence and feature set are the decision here; SKU pricing and billing integration are deferred.

---

### Decision 5 — Telemetry collection policy

**Approach: opt-in, runtime-aggregated, never-collect code/prompts**

Telemetry is:
- Controlled by the `managed-telemetry` license feature (only available in `managed-runtime` and `enterprise` tiers)
- Opt-in by default: `URATEAM_TELEMETRY_ENABLED=false` unless explicitly set to `true`
- Can be permanently disabled by the operator regardless of license tier

**Collected (when opted in):**

| Metric | Granularity | Rationale |
|---|---|---|
| Pipeline run count per day | Aggregate count, no run IDs | Usage-based scaling signals |
| Stage success/failure rates | Per-stage boolean, no error messages | Quality monitoring |
| Error category distribution | Enum bucket (auth/network/rate-limit/other) | Reliability signals |
| Runtime version | Package.json version string | Deprecation planning |
| Deployment mode | `sqlite`/`postgres`, `docker`/`bare` | Infrastructure planning |
| License tier | Enum string | Feature adoption |
| Approximate team size (seats claim from JWT) | Integer range bucket (1-10, 11-50, 51+) | Pricing calibration |

**Never collected, under any circumstances:**

- Source code content (diff, file contents, handoff data)
- Issue titles, descriptions, or comments (even truncated or hashed)
- Agent prompts or completions
- Token counts (input/output per run)
- API keys, tokens, or credentials of any kind
- Usernames, email addresses, Linear/GitHub user IDs
- Repository names or organization names
- Pipeline configuration values (except tier, version, and DB driver)
- IP addresses or network topology

**Telemetry implementation:**

Telemetry is batched locally by the PM Agent tick (daily), aggregated over the `pipeline_runs` table using only the fields listed above, and posted to `https://telemetry.urateams.com/v1/batch` with the runtime JWT. The payload is logged locally before transmission so operators can audit what is sent. On `URATEAM_TELEMETRY_LOG_ONLY=true`, the payload is logged but not transmitted (useful for auditing the collection before enabling).

```typescript
// packages/core/src/telemetry/reporter.ts
export interface TelemetryBatch {
  customerId: string;          // from license JWT
  timestamp: string;           // UTC date, day precision only
  runtimeVersion: string;
  deploymentMode: "sqlite" | "postgres";
  tier: "pro" | "managed-runtime" | "enterprise";
  seatsBucket: "1-10" | "11-50" | "51+";
  runsToday: number;
  stageSummary: Record<StageType, { succeeded: number; failed: number }>;
  errorBuckets: Record<"auth" | "network" | "rate-limit" | "other", number>;
}
```

Telemetry is **never** collected on `oss` or `pro` tiers, even if opted in (the license gate prevents it).

---

## 3. Architecture overview

```
                         ┌────────────────────────────────────────────────────┐
                         │         urateams.com Hosted Layer                  │
                         │                                                     │
  ┌──────────┐  HTTPS    │  ┌─────────────────────────────────────────────┐  │
  │  Linear  ├──────────►│  │ Webhook Receiver                             │  │
  └──────────┘           │  │  - verifies Linear HMAC signature            │  │
                         │  │  - verifies GitHub App signature             │  │
  ┌──────────┐  HTTPS    │  │  - resolves customer_id from installation_id │  │
  │  GitHub  ├──────────►│  │  - signs payload with customer HMAC secret   │  │
  └──────────┘           │  │  - enqueues to per-customer channel          │  │
                         │  └──────────────────┬────────────────────────────┘  │
                         │                     │                               │
                         │  ┌──────────────────▼────────────────────────────┐  │
                         │  │ Channel Manager (Durable Object / Fly WS)     │  │
                         │  │  - maintains SSE connection per customer       │  │
                         │  │  - delivers signed webhook payloads            │  │
                         │  │  - retries on ACK timeout (3 attempts, 5s)    │  │
                         │  └──────────────────┬────────────────────────────┘  │
                         │                     │ SSE stream (auth'd JWT)        │
                         │  ┌──────────────────▼────────────────────────────┐  │
                         │  │ API Service (api.urateams.com)                │  │
                         │  │  - POST /v1/managed-runtime/enroll            │  │
                         │  │  - POST /v1/managed-runtime/token/refresh     │  │
                         │  │  - POST /v1/telemetry/batch                   │  │
                         │  │  - GET  /v1/managed-runtime/status            │  │
                         │  └───────────────────────────────────────────────┘  │
                         └────────────────────────────────────────────────────┘
                                              │ SSE (outbound from customer)
                         ┌────────────────────▼────────────────────────────────┐
                         │         Customer Runtime (self-hosted infra)         │
                         │                                                      │
                         │  ┌───────────────────────────────────────────────┐  │
                         │  │ Tunnel Client (managed-runtime/tunnel-client)  │  │
                         │  │  - opens SSE connection at startup             │  │
                         │  │  - verifies HMAC on every received payload     │  │
                         │  │  - calls local webhook handler (localhost)     │  │
                         │  │  - auto-renews JWT before expiry               │  │
                         │  └───────────────────────────────────────────────┘  │
                         │                                                      │
                         │  ┌─────────┐   ┌──────────┐   ┌──────────────────┐ │
                         │  │ Runner  │   │ PM Agent │   │ Dashboard/API    │ │
                         │  └─────────┘   └──────────┘   └──────────────────┘ │
                         │                                                      │
                         │  ┌─────────────────────────────────────────────┐   │
                         │  │ Agent Process + Git Worktrees + DB           │   │
                         │  │ (Claude API key, Linear key — never leave)  │   │
                         │  └─────────────────────────────────────────────┘   │
                         └──────────────────────────────────────────────────────┘
```

### Service responsibilities

| Service | Host | Technology | Purpose |
|---|---|---|---|
| Webhook Receiver | Cloudflare Workers | TypeScript | Inbound HTTPS endpoints, signature verification, customer routing |
| Channel Manager | Cloudflare Durable Objects | TypeScript | Persistent SSE connection per customer, delivery + retry |
| API Service | Cloudflare Workers | TypeScript | Enrollment, token refresh, telemetry ingestion |
| Installations DB | Cloudflare D1 / KV | SQL | `installation_id` → `customer_id` routing table |
| Tunnel Client | Customer runtime | TypeScript (`@urateam/core`) | SSE subscriber, HMAC verifier, local webhook dispatcher |

---

## 4. Integration points with existing code

### 4.1 Tunnel client startup

The tunnel client is activated in `packages/core/src/managed-runtime/tunnel-client.ts`. It is initialized from `packages/cli/src/start.ts` and `packages/cli/src/dev.ts` immediately after license validation:

```typescript
// packages/cli/src/start.ts (addition)
import { startTunnelClient } from "@urateam/core";

// After createDb() and checkLicense()
if (isFeatureLicensed("managed-runtime-networking")) {
  const tunnelClient = await startTunnelClient({
    customerToken: process.env.URATEAM_MANAGED_RT_TOKEN!,
    webhookSecret: process.env.URATEAM_MANAGED_RT_WEBHOOK_SECRET!,
    localWebhookUrl: `http://localhost:${config.port}/webhooks`,
    logger,
  });
  // tunnelClient.stop() called in shutdown handler
}
```

### 4.2 Webhook handler compatibility

The tunnel client POSTs to the existing local webhook endpoint (`/webhooks/linear`, `/webhooks/github`) with the original payload and a synthetic `X-Linear-Signature` / `X-Hub-Signature-256` header re-generated using the local `URATEAM_WEBHOOK_SECRET`. No changes to `packages/core/src/webhook/handler.ts` are required — the tunnel client is a transparent forwarder from the handler's perspective.

### 4.3 License gating

`packages/core/src/license.ts` additions:

```typescript
export const MANAGED_RUNTIME_FEATURES: LicenseFeature[] = [
  ...PRO_FEATURES,
  "managed-runtime-networking",
  "managed-telemetry",
];

// In resolveFeaturesForTier():
case "managed-runtime":
  return new Set(MANAGED_RUNTIME_FEATURES);
```

### 4.4 Telemetry reporter integration

`packages/core/src/telemetry/reporter.ts` is called from `packages/core/src/pm/scheduler.ts` at the end of each daily PM tick:

```typescript
// packages/core/src/pm/scheduler.ts (addition, after pruneAuditLog)
if (isFeatureLicensed("managed-telemetry") && config.telemetry?.enabled) {
  await reportTelemetryBatch(db, config, logger).catch((err) =>
    logger.warn({ err }, "telemetry report failed (non-fatal)")
  );
}
```

### 4.5 CLI enrollment command

`packages/cli/src/commands/managed-runtime.ts` adds:

```
ura managed-runtime enroll --email <email>
ura managed-runtime status
ura managed-runtime refresh-token
```

---

## 5. Phased implementation plan

### Phase 1 — Webhook forwarding (MVP, ~4 weeks)

**Scope:** Eliminate the need for customers to configure a public webhook URL.

Deliverables:
- Cloudflare Worker: `webhooks.urateams.com` inbound receiver for Linear + GitHub
- Cloudflare Durable Object: per-customer SSE channel
- `managed-runtime/tunnel-client.ts` in `@urateam/core`
- Enrollment flow: `ura managed-runtime enroll`
- `managed-runtime-networking` license feature gate
- Docs: `deploy/MANAGED_RUNTIME_SETUP.md`

**Does not include:** managed GitHub App (customers still register their own App in Phase 1).

**Acceptance test:** A runtime behind NAT with no public IP, no Caddy, and no Cloudflare tunnel successfully processes a Linear issue to PR in under 5 minutes from install.

### Phase 2 — Managed GitHub App (~2 weeks)

**Scope:** Eliminate GitHub App registration.

Deliverables:
- `urateam-bot` GitHub App registered under `urateams` org
- `installations` table in hosted layer D1 DB
- Installation routing in Webhook Receiver
- GitHub App installation link in `ura managed-runtime enroll` output
- Test: mis-routing attack (HMAC mismatch on wrong-channel delivery)

### Phase 3 — License validation endpoint (~1 week)

**Scope:** Optional real-time license revocation (prevents offline JWT from being reused post-cancellation).

Deliverables:
- `POST /v1/license/validate` endpoint in API Service (rate-limited to 1/hour per customer)
- `checkLicense()` attempts online validation if `URATEAM_LICENSE_VALIDATE_ONLINE=true` is set; falls back to offline on network failure
- Cache TTL: 1 hour (same as current offline window for revocation tolerance)

### Phase 4 — Telemetry pipeline (~1 week)

**Scope:** Opt-in usage reporting.

Deliverables:
- `telemetry/reporter.ts` in `@urateam/core`
- `POST /v1/telemetry/batch` ingestion endpoint
- Telemetry data pipeline (Cloudflare Analytics Engine or ClickHouse)
- Operator dashboard stub at `admin.urateams.com` (internal only at launch)

---

## 6. Open questions and deferred decisions

| Question | Status | Notes |
|---|---|---|
| Pricing and SKU for managed-runtime tier | Deferred to BEC-132 | This spec does not set prices |
| Cloudflare Durable Objects vs Fly.io WebSocket | Phase 1 decision | DO is simpler to operate; Fly gives more control. Evaluate at Phase 1 kickoff |
| SLA for webhook forwarding latency | Deferred | P99 < 2s target; formal SLA once reliability data exists |
| Managed Slack App | Deferred to post-Phase 2 | Same architecture as managed GH App; lower priority |
| Customer data residency (EU vs US) | Deferred | Webhooks are forwarded and not persisted; D1 replication region is a concern for routing table |
| Self-service offboarding (disconnect managed runtime) | Phase 2 | `ura managed-runtime disconnect` — removes SSE channel, deletes installation routing |
| Multi-runtime per customer (e.g. staging + prod) | Phase 2 | Multiple `URATEAM_MANAGED_RT_CUSTOMER_ID` scopes per license; routing table has composite key |

---

## 7. Security considerations

- **Payload integrity:** Every webhook forwarded over SSE is HMAC-SHA256 signed with the customer's `webhookSecret`. The tunnel client verifies before passing to the local handler. A compromised hosted layer cannot inject payloads.
- **Credential isolation:** Only two runtime secrets touch the hosted layer: the short-lived `runtimeToken` (24h JWT) and the enrollent-time `webhookSecret` hash. No agent execution credentials ever leave the customer's box.
- **Tenant isolation:** The `installation_id → customer_id` routing table in D1 is the only multi-tenancy boundary. It must be covered by integration tests that verify mis-routing is caught by HMAC verification at the receiver.
- **Replay attacks:** Forwarded payloads include the original `X-Linear-Delivery` or `X-GitHub-Delivery` header. The existing `webhookDedup` table in `handler.ts` (dedup TTL 30s) prevents replay attacks end-to-end.
- **DDoS amplification:** The webhook receiver applies per-customer rate limiting (Cloudflare rate-limiting rules) before enqueueing. A malicious actor flooding a customer's endpoint cannot flood the customer's runtime.
- **Override label threat model** (inherited from org-policy gate): the `overrideLabel` bypass in pipeline policy relies on Linear label creation being restricted to trusted principals. The managed-runtime tier does not change this threat model.

---

## 8. Compliance notes

- Customer code never transits the hosted layer. Webhook payloads contain only issue metadata (IDs, state changes, comment excerpts) — the same data Linear/GitHub send to any third-party webhook receiver.
- The hosted layer is stateless with respect to customer data: webhooks are forwarded in-flight and not written to persistent storage (only the routing table and rate-limit counters are persisted).
- BSL 1.1 compatibility: the managed-runtime tier does not change the software license. The hosted layer is a separate, proprietary service operated by urateam. The runtime-side tunnel client code in `@urateam/core` is BSL-licensed (same as the rest of the package).
- SOC 2 path: the hosted layer's stateless design (no customer event storage) significantly reduces SOC 2 audit scope. Phase 4 telemetry data is aggregated-only and falls under Type II controls for data minimization.

---

*Next steps: Validate networking model choice (Durable Objects vs Fly) at Phase 1 kickoff. Unblock on BEC-132 for pricing tier decisions. Implementation tickets to follow this spec.*
