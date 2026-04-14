# Design: Enterprise tier, packaging, and license infrastructure

**Date**: 2026-04-13
**Status**: Draft for review
**Scope**: Defines the urateam commercial tier structure, the Enterprise feature set targeted at mid-size scale-ups, and the license/billing infrastructure that gates them.

This is a meta-spec. It establishes the *strategy* and *boundaries*. Each Enterprise feature listed below will get its own implementation spec when it's queued for build.

---

## 1. Goals and non-goals

### Goals
- Define a coherent three-tier commercial structure (OSS / Pro / Enterprise) that replaces the current four-tier scaffold in `packages/core/src/license.ts`.
- Identify the seven Enterprise features that unblock a 100-engineer scale-up VP Eng.
- Specify the license validation infrastructure and billing path so the first paying customer can be onboarded in ~1 week of focused work.
- Establish where the existing PM Agent capabilities sit on the tier ladder.

### Non-goals
- Building any individual Enterprise feature (each gets its own spec).
- SOC2, HIPAA, FedRAMP compliance work — these belong to a future "Enterprise Plus" tier targeting regulated buyers, not this design.
- On-prem Helm chart, BYO-LLM routing, air-gapped operation — same reason. Future tier.
- Multi-tenant runtime / white-label — not the buyer profile we're targeting.
- Picking the actual price points. The spec describes pricing *shape* (per-org flat with seat cap, sales-led Enterprise); the dollar amounts are a separate go-to-market decision.

## 2. Buyer profile

The target customer is a **mid-size scale-up, 50–500 engineers**, already on Linear + GitHub. They have a security review process but no formal compliance team. Buyer is VP Eng or Head of Platform.

This buyer profile was chosen for lowest barrier to entry:
- Days-to-weeks sales cycle vs. 6–12 months for regulated enterprise.
- Single buyer signs the PO; no security committee, no procurement office, no RFP.
- No compliance prerequisite (SOC2 etc.) before the first conversation.
- The features that unblock them are the cheapest to build: SSO via WorkOS, audit log, cost dashboard, basic RBAC. No on-prem deploy, no BYO-LLM, no air-gap.
- Price tolerance: $500–$5k/mo is normal — enough for a real revenue line, not enough to need a procurement review.

Other buyer profiles (regulated enterprise, big-tech platform teams, white-label) are explicitly deferred. They each require capabilities that would need to be built *first* before pitching them, and the right time to do that is after this tier has reference customers.

## 3. Tier structure

Replace the current `free | pro | team | enterprise` enum with **three tiers**: `oss | pro | enterprise`. The "team" tier is removed — it blurs into Pro and consistently confuses buyers in similar products.

| Tier | Buyer | Price shape | Headline pitch |
|---|---|---|---|
| **OSS** | Solo devs, OSS maintainers, evaluation, hobbyists | $0, self-hosted, BYO Anthropic key | "Run the full pipeline against your own repo for free." |
| **Pro** | Startups, small teams (<50 eng) | **$X/mo flat per org, up to 25 active users**; above that, contact sales | "Your autonomous engineering manager." |
| **Enterprise** | Scale-ups (50–500 eng) | Sales-led, $Z+/mo | "Run urateam org-wide with the controls your security team needs." |

The seat cap on Pro creates a natural upsell trigger: a customer growing past 25 active users is automatically a sales-qualified Enterprise lead.

### Feature matrix

| Capability | OSS | Pro | Enterprise |
|---|---|---|---|
| **Pipeline core** (triage, implement, test, review, RALPH gate, draft PRs) | ✓ | ✓ | ✓ |
| **PM Agent core loop** (cron, triage, promote, stuck-issue recovery, start-todo) | ✓ | ✓ | ✓ |
| **Multi-repo** | — | ✓ | ✓ |
| **Stage models** (per-stage model override) | — | ✓ | ✓ |
| **Advanced auto-merge** | — | ✓ | ✓ |
| **Deep review** | — | ✓ | ✓ |
| **PM Agent — conflict detection** (Claude predicts merge overlap before promoting) | — | ✓ | ✓ |
| **PM Agent — approval workflows** (Slack-reaction-gated deprioritize/cancel) | — | ✓ | ✓ |
| **PM Agent — Slack interface** (bidirectional bot, slash commands, @mentions) | — | ✓ | ✓ |
| **SSO (SAML/OIDC)** | — | — | ✓ |
| **Audit log + export** | — | — | ✓ |
| **Spend caps & alerts** (per-team/per-repo budgets, Slack alerts at 50/80/100%) | — | — | ✓ |
| **RBAC** (admin/operator/viewer, scoped to teams or repos) | — | — | ✓ |
| **Cost & ROI dashboard** (tokens, PRs merged, time saved, by team/repo) | — | — | ✓ |
| **Org policy / guardrails** (file-pattern blocklists, mandatory reviewers, complexity caps) | — | — | ✓ |
| **PM Agent governance** (per-team budgets, RBAC on approvals, audit of decisions, policy guardrails) | — | — | ✓ |
| **Priority support + Slack channel + SLA** | — | — | ✓ |

### PM Agent split rationale

The PM Agent is urateam's headline differentiator and warrants careful tier placement:
- **Free PM Agent** runs unattended but operates "dumb" — no human-in-the-loop, no merge-conflict awareness, no Slack interface. It still does useful work (triage, promote, recover stuck issues), so the OSS pitch is real.
- **Pro PM Agent** adds the smart layer (conflict detection, approval workflows, Slack interface). This is the actual reason to upgrade to Pro — the pitch becomes "your autonomous engineering manager."
- **Enterprise PM Agent** adds the governable layer (per-team budgets, RBAC on approvals, audit log of decisions, policy guardrails) — the reason a 200-engineer org will actually turn it on org-wide instead of leaving it gated to one team.

This three-step ladder is preserved in the existing code, where `conflict-detection`, `approval-workflows`, and `slack-interface` already gate via `isFeatureLicensed()` in `packages/core/src/pm/scheduler.ts`. The implementation work is mostly extending that pattern, not introducing new gates.

## 4. Enterprise feature shortlist

The seven features below were selected to clear the security review and demo loop for the target buyer. They are sorted by build cost so the implementation order can favour fastest-to-revenue.

### 4.1 SSO (SAML / OIDC) — **hard blocker**
Without SSO, the dashboard is a rogue tool that the buyer's identity team will refuse to allow. Implementation: integrate WorkOS or Auth0 for SAML/OIDC. Dashboard gains an org-scoped session model. **Estimated effort: 1–2 weeks.**

### 4.2 Audit log + export — **hard blocker**
Append-only log of every meaningful action: who triggered run X, what the agent did, what it cost, when. Exportable to CSV/Splunk. Most of the data is already in `runs`, `agent_logs`, and `webhookDedup` tables — this is primarily a UI, an export job, and a guarantee of immutability. **Estimated effort: 1 week.**

### 4.3 Spend caps & alerts — **hard blocker**
Per-team and per-repo budgets, Slack alerts at 50%/80%/100% of budget, hard cap that aborts new pipeline runs above 100%. Extends the existing `dailyTokenBudget` mechanism in the PM Agent scheduler — the gate is already there, the work is making it scoped per team/repo and surfacing the alerts. **Estimated effort: 3–4 days.**

### 4.4 RBAC / multi-user — **tier differentiator**
Roles: admin, operator, viewer. Scoped to teams or repos. Dashboard gains a user table and an authorization layer. Operator can trigger runs but not change config; viewer can see runs but not trigger them. **Estimated effort: 3–4 weeks.**

### 4.5 Cost & ROI dashboard — **tier differentiator**
Aggregations on existing tables: tokens spent, PRs merged, time saved, broken down by team/repo/issue. The artefact the VP Eng shows the CFO at QBR to justify renewal — this is the renewal-protection feature. Mostly query work plus a dashboard view. **Estimated effort: 2 weeks.**

### 4.6 Org policy / guardrails — **tier differentiator**
File-pattern blocklists (the agent cannot touch `/infra/**` without an explicit override), per-repo mandatory reviewers, max-complexity caps, max-cost-per-issue caps. Extends the existing `autoMergeExcludePatterns` model — same glob matching, applied at the pipeline gate rather than just at auto-merge. **Estimated effort: 2 weeks.**

### 4.7 Priority support + Slack channel + SLA — **tier differentiator**
Pure labour, no engineering. Shared Slack channel between urateam and the customer, response-time commitment. Mention in the contract. **Effort: zero engineering, ongoing labour cost.**

### Build order recommendation
Ship in order: **4.7 (free) → 4.3 → 4.2 → 4.1 → 4.6 → 4.5 → 4.4**. Rationale: the cheapest hard blockers first (so you can start having Enterprise conversations), then the differentiators in increasing complexity. RBAC is last because it's the largest and the workaround (one shared admin account) is acceptable for the first 2–3 design partners.

## 5. License infrastructure

### 5.1 Architecture

**Validation is offline.** urateam embeds a public key at build time and validates signed JWT license keys locally. No phone-home, no licensing service to operate, air-gap compatible by default.

**Pro is self-serve via Stripe.** A small webhook handler, hosted on Vercel or Cloudflare Workers, listens for Stripe subscription events and generates+emails a JWT when a customer subscribes. When a subscription lapses, the next-issued key has the new expiry; the customer's existing key keeps working until its expiry, and a renewal email is triggered before then.

**Enterprise is sales-led, manual at first.** A CLI tool generates a JWT with the agreed-upon `tier`, `seats`, `expiresAt`, and `customerId` claims. The salesperson emails it after contract close. No automation needed until there are ~5 Enterprise customers; then automate.

This design defers the "real license server" decision (real-time revocation, telemetry, seat enforcement) until there is enough revenue to justify operating a HA service. The Option B license-server-with-cached-JWTs design is a future migration; nothing in the JWT format prevents adopting it later.

### 5.2 JWT shape

```jsonc
{
  "iss": "urateam.dev",
  "sub": "<customerId>",
  "tier": "pro" | "enterprise",
  "seats": <number | null>,         // null = unlimited (Enterprise default)
  "iat": <unix-seconds>,
  "exp": <unix-seconds>,
  "features": ["slack-interface", "..."]  // optional explicit override list
}
```

The `features` array is optional. When absent, urateam derives the feature set from `tier` using the table in section 3. This lets us ship custom feature bundles to design partners without changing the tier model.

Signature: **EdDSA (Ed25519)**. Smaller signatures than RSA, faster validation, no padding/curve foot-guns. Public key embedded in `packages/core/src/license/public-key.ts` at build time.

### 5.3 Changes to `packages/core/src/license.ts`

Replace the current `checkLicense()` placeholder with:

```ts
export interface LicenseStatus {
  licensed: boolean;
  tier: "oss" | "pro" | "enterprise";
  customerId?: string;
  expiresAt?: Date;
  seats?: number | null;
  features: Set<string>;
  // Reason a license check failed, surfaced in dashboards / startup logs.
  invalidReason?: "missing" | "expired" | "bad-signature" | "wrong-issuer";
}

export function checkLicense(): LicenseStatus;            // cached for process lifetime
export function isFeatureLicensed(feature: string): boolean;
export function _resetLicenseCache(): void;               // for tests
```

Behaviour:
- **No `URATEAM_LICENSE_KEY` env var** → tier `oss`, `features` = the OSS feature set. No warning.
- **Invalid signature / wrong issuer** → tier `oss`, `invalidReason` set, log a clear warning at startup. Pipeline still runs.
- **Expired** → tier `oss`, `invalidReason` = `"expired"`, warning logged, pipeline still runs but commercial features are disabled. Dashboard shows a renewal banner.
- **Valid Pro JWT** → tier `pro`, features derived from tier (or from the JWT's `features` override).
- **Valid Enterprise JWT** → tier `enterprise`, features derived from tier (or override).

The four-tier `free | pro | team | enterprise` enum is replaced with `oss | pro | enterprise`. The renaming from `free` to `oss` matches the marketing name; "team" is removed entirely. A migration note in the changelog will explain the rename.

### 5.4 Stripe webhook handler

A separate ~150-line service, **not** part of the urateam monorepo. Hosted on Vercel or Cloudflare Workers. Single endpoint: `POST /stripe/webhook`.

Handles three Stripe events:
- `checkout.session.completed` → generate JWT, email customer, store `(customerId, stripeSubscriptionId, jwtIssuedAt)` in a small KV store for audit.
- `customer.subscription.updated` → if status changed to `active` from a non-active state, re-issue the JWT.
- `customer.subscription.deleted` / `subscription.paused` → log, send a "your license expires on X" email. The current JWT keeps working until its `exp`.

JWT signing key lives in the webhook handler's secrets. urateam itself never sees the private key. This isolation means a urateam compromise cannot mint new licenses.

This service is **out of scope for the urateam monorepo**. It will live in a separate repo (`urateam-licensing`) and is its own implementation spec when queued.

### 5.5 Enterprise CLI tool

A small Node script in `packages/cli/src/commands/license.ts` (admin-only, not exposed in `--help` of the public `ura` CLI):

```
ura license issue --customer-id acme --tier enterprise --seats 100 --expires 2027-04-13
```

Reads the private signing key from `URATEAM_LICENSE_SIGNING_KEY` env var (operator-only). Outputs a signed JWT. The operator pastes it into an email after contract close.

This is engineering's tool, not a product surface. It exists so the founder can issue Enterprise keys without standing up the full Stripe pipeline first.

## 6. Implementation phases

### Phase 0 — License infrastructure (week 1)
- Replace `checkLicense()` with offline JWT validation (Ed25519, embedded public key).
- Update tier enum to `oss | pro | enterprise`. Migration note in CHANGELOG.
- Build the `ura license issue` CLI tool.
- Generate a signing keypair, store the private key securely, embed the public key.
- **Deliverable**: a real JWT can gate the existing commercial features. Manual key issuance works for both Pro and Enterprise.

### Phase 1 — Pro self-serve (week 2)
- Build the standalone `urateam-licensing` repo with the Stripe webhook handler.
- Wire it to a Stripe Checkout session for Pro.
- Send the first JWT to a real email.
- **Deliverable**: a stranger can buy Pro on the website without human involvement.

### Phase 2 — Enterprise hard blockers (weeks 3–5)
- Ship 4.7 (priority support — zero engineering, just contract language).
- Ship 4.3 (spend caps & alerts — extends existing budget guard).
- Ship 4.2 (audit log + export).
- Ship 4.1 (SSO via WorkOS).
- **Deliverable**: a sales conversation with a real Enterprise prospect can pass their security review.

### Phase 3 — Enterprise differentiators (weeks 6–10)
- Ship 4.6 (org policy / guardrails).
- Ship 4.5 (cost & ROI dashboard).
- Ship 4.4 (RBAC).
- **Deliverable**: full Enterprise feature set is shippable to a design partner.

Each numbered feature in Phase 2 and Phase 3 will get its own implementation spec when it reaches the top of the queue. This document defines *what* and *why*; per-feature specs define *how*.

## 7. Open questions

These are decisions deferred to feature-level specs or to go-to-market work, not blockers for this design:
- **Pro price point in dollars** — go-to-market decision, depends on competitive research.
- **Stripe vs. Paddle vs. Lemon Squeezy** for billing — depends on tax-handling needs.
- **WorkOS vs. Auth0** for SSO — depends on pricing at expected volume; both work.
- **Audit log retention period** — likely 1 year for Pro upgrades, longer for Enterprise.
- **Whether to run a real license server (Option B)** — revisit when there are 50+ paying customers and revocation/telemetry pain becomes real.

## 8. Out-of-scope features (explicitly deferred)

Listed here so they're not lost:
- Multi-workspace Slack support
- GitHub Enterprise Server support
- Self-hosted Helm chart with versioned releases
- Outbound webhooks for run lifecycle events
- Per-team custom pipeline configs (partly exists via `stageModels`)
- BYO-LLM routing (Bedrock, Vertex, Azure OpenAI in customer's account)
- Air-gapped operation
- SOC2 / HIPAA / FedRAMP certification
- Multi-tenant runtime / white-label
- SCIM provisioning

Most of these belong to a future "Enterprise Plus" tier targeting regulated buyers. We do not build them until the current Enterprise tier has reference customers.
