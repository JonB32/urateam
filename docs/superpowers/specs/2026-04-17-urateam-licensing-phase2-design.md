# Design: urateam-licensing — Phase 2 Pro self-serve billing

**Date**: 2026-04-17
**Status**: Draft for review
**Scope**: Specifies the standalone `urateam-licensing` service that mints, emails, and re-delivers Pro-tier license JWTs in response to Stripe subscription events. Lives in a **separate private repo**, not in the urateam monorepo. Implements Phase 1 of the "Pro self-serve" track in [the 2026-04-13 tier design spec § 5.4 and § 6](./2026-04-13-enterprise-tier-design.md).

This is an implementation spec. It follows the meta-spec's strategy decisions (offline Ed25519 JWT, BSL 1.1, three-tier model) and specifies the billing service's architecture, data flow, error handling, and testing.

---

## 1. Goals and non-goals

### Goals
- Allow a stranger to buy urateam Pro on the marketing site without human involvement, receive a working JWT by email within ~60 seconds, and run `export URATEAM_LICENSE_KEY=...` to unlock Pro features.
- Handle monthly renewals automatically: fresh 13-month JWTs emailed 14 days before expiry, re-issued on each successful invoice.
- Provide a lost-key recovery flow via email magic link, requiring no account/password system.
- Provide Stripe Customer Portal for cancel / update card / invoice history — zero custom billing UI.
- Ship with the signing key isolated to the billing Worker; urateam itself never sees the private key.
- Be operable by a solo founder: one repo, one Cloudflare deploy, no always-on VPS.

### Non-goals
- Annual pricing (monthly only at launch; annual deferred to 2.5).
- Seat enforcement (JWT `seats: 25` is informational; honor-system at v1 matching the strategy spec).
- In-app "approaching seat limit" UX in the urateam dashboard.
- Invoicing-by-PO or custom contracts (sales-led Enterprise track handles this separately).
- Real-time license revocation (deferred to Phase 3 telemetry per the tier design § 5.1).
- Multi-workspace, multi-org-per-customer, team billing management.
- Coupons, discounts, free trials (add post-launch if GTM asks for them).

## 2. Architecture

### 2.1 Deployment topology

One Cloudflare Worker at `billing.urateams.com`, plus a static pricing page at `urateams.com/pricing` served from Cloudflare Pages. Both deploy from the same monorepo. The pricing page is ~40 lines of HTML + Tailwind via CDN, no build step.

**Marketing domain**: `urateams.com` does not currently host a pricing page. Phase 2 scope includes a minimal one-page `/pricing` route. Full marketing site build-out is out of scope.

### 2.2 Repo structure

```
urateam-licensing/                        (private GitHub repo)
├── worker/
│   ├── src/
│   │   ├── index.ts              # router, entry point
│   │   ├── routes/
│   │   │   ├── checkout.ts       # POST /checkout
│   │   │   ├── webhook.ts        # POST /stripe/webhook
│   │   │   ├── recover.ts        # POST /recover, GET /recover/:token
│   │   │   └── admin.ts          # GET /admin/audit (HTTP Basic Auth)
│   │   ├── lib/
│   │   │   ├── jwt.ts            # Ed25519 sign + verify
│   │   │   ├── stripe.ts         # webhook signature verify, event handlers
│   │   │   ├── email.ts          # Resend client + template dispatch
│   │   │   ├── magic-link.ts     # HMAC token mint + verify
│   │   │   └── kv.ts             # KV namespace helpers
│   │   ├── templates/
│   │   │   ├── welcome.html      # "Your Pro license key"
│   │   │   ├── renewal.html      # "Your renewed key"
│   │   │   ├── lapsed.html       # "Subscription ended"
│   │   │   └── recover.html      # "Your magic link"
│   │   └── scheduled.ts          # cron handler (daily renewal sweep)
│   ├── wrangler.toml
│   ├── vitest.config.ts
│   └── package.json
├── pages/
│   ├── index.html                # urateams.com landing (minimal)
│   └── pricing.html              # urateams.com/pricing
├── .github/workflows/
│   ├── ci.yml                    # lint + test + dry-run deploy on PR
│   └── deploy.yml                # prod deploy on main
├── scripts/
│   └── manual-test.ts            # stripe CLI harness
├── docs/
│   ├── DEVELOPING.md
│   ├── OPERATIONS.md
│   └── rotation.md               # signing key + secrets rotation playbook
└── README.md
```

### 2.3 Worker routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/checkout` | Creates Stripe Checkout Session with `organization` custom field; 303 to hosted page |
| `POST` | `/stripe/webhook` | Handles `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted` |
| `POST` | `/recover` | Accepts email; sends magic link via Resend |
| `GET`  | `/recover/:token` | Validates magic link; renders page with JWT + `.jwt` download + pre-generated Stripe Portal URL |
| `GET`  | `/admin/audit` | HTTP Basic Auth; returns audit trail for a given customerId |
| `GET`  | `/health` | Liveness check |

Scheduled handler: daily cron at 06:00 UTC scans `LICENSES` for keys expiring ≤14 days and re-mints any with active Stripe subscriptions.

### 2.4 Storage — Cloudflare KV namespaces

- **`LICENSES`** — key: `cus_xxx` (Stripe customer id). Value:
  ```jsonc
  {
    "stripeSubscriptionId": "sub_xxx",
    "currentJwt": "eyJ...",
    "issuedAt": 1713398400,
    "expiresAt": 1747555200,          // 13 months out
    "email": "ops@acme.com",
    "organization": "Acme Corp"
  }
  ```
  No TTL. Cleared manually if/when a customer requests deletion.

- **`MAGIC_LINKS`** — key: 32-byte hex token. Value: `{ customerId, expiresAt }`. TTL 900s via KV native expiration. Deleted on first use.

- **`AUDIT`** — key: `{customerId}:{ts-micros}`. Value: `{ action, ip, userAgent }` where action ∈ `issued | renewed | recovered | lapsed | portal-opened`. TTL 1 year.

### 2.5 Secrets (Workers Secrets)

- `SIGNING_KEY` — Ed25519 private key (PEM). Public half embedded in `@urateam/core` at build time.
- `STRIPE_SECRET_KEY` — Stripe API key (live in prod, test in dev).
- `STRIPE_WEBHOOK_SECRET` — for verifying `POST /stripe/webhook` signatures.
- `RESEND_API_KEY` — Resend transactional email.
- `MAGIC_LINK_HMAC_SECRET` — signs magic-link tokens to prevent forgery.
- `ADMIN_BASIC_AUTH` — `user:bcrypt-hash` for the `/admin/audit` route.

### 2.6 JWT shape (unchanged from tier design spec § 5.2)

```jsonc
{
  "iss": "urateams.com",
  "sub": "cus_xxx",           // Stripe customer id
  "tier": "pro",
  "seats": 25,                // informational; not enforced in v1
  "iat": 1713398400,
  "exp": 1747555200           // iat + 13 months
}
```

Signature: EdDSA / Ed25519. Public key is the same one already embedded in `@urateam/core`.

**Cross-repo coordination**: `packages/core/src/license.ts` in the urateam repo currently has `const ISSUER = "urateam.dev"`. Phase 2 changes the canonical domain to `urateams.com`. A companion PR in the urateam repo is a prerequisite to Phase 2 deployment — it must merge and release before the billing Worker starts minting JWTs with `iss: "urateams.com"`. Since no paying customers exist at Phase 2 launch, this is a clean cutover with no back-compat burden.

## 3. Data flow

### 3.1 First-time purchase

1. Visitor lands on `urateams.com/pricing`, clicks **Buy Pro**.
2. Browser `POST`s to `billing.urateams.com/checkout`.
3. Worker calls `stripe.checkout.sessions.create` with: `mode: "subscription"`, the monthly Pro price id (read from Workers env var `STRIPE_PRO_PRICE_ID`), `customer_email` if provided, `custom_fields: [{ key: "organization", label: "Organization name", type: "text" }]`, and a freshly generated `client_reference_id` UUID.
4. Browser follows the 303 redirect to Stripe's hosted checkout. User pays.
5. Stripe fires `checkout.session.completed` → Worker verifies signature and extracts `customer`, `subscription`, `custom_fields.organization`, `customer_email`.
6. **Idempotency check**: if `LICENSES[customerId]` already has the same `subscriptionId`, short-circuit with 200. Otherwise continue.
7. Worker mints JWT with `sub: customerId`, `exp: now + 13 months`.
8. Writes `LICENSES[customerId] = { subId, jwt, issuedAt, expiresAt, email, organization }`.
9. Sends welcome email via Resend: JWT in code block, `.jwt` file attachment, env-var instructions.
10. Appends `AUDIT[customerId:ts] = { action: "issued", ... }`.
11. Returns 200 to Stripe.
12. Stripe's success URL → `urateams.com/thanks?session_id={CHECKOUT_SESSION_ID}` renders "Check your email — sent to ops@acme.com."

### 3.2 Monthly renewal (happy path)

1. Stripe fires `invoice.paid` (once per month per active subscription).
2. Worker looks up `customerId` in `LICENSES`.
3. If `expiresAt - now > 30 days`, no-op (key is fresh, don't spam re-issues).
4. Else, re-mint JWT with `exp: now + 13 months`, update KV, append `AUDIT` entry.
5. Return 200.

Separately, the **daily cron handler** scans `LICENSES` for keys where `expiresAt - now ≤ 14 days`. For each, it calls `stripe.subscriptions.retrieve`; if `status === "active"`, re-mints + sends renewal email; otherwise no-op (the lapse flow will handle it).

### 3.3 Payment failure

1. Stripe's smart_retries attempts payment for ~3 weeks. No Worker action during retries (Stripe handles the customer dunning emails).
2. If all retries exhaust, Stripe fires `customer.subscription.deleted`.
3. Worker reads `LICENSES[customerId]`, sends lapsed email with the current key's expiry date and a link to `billing.urateams.com/recover` to resubscribe. Does **not** invalidate the current JWT.
4. Appends `AUDIT` entry with `action: "lapsed"`.

This honor-system behavior is intentional per the strategy spec: revocation arrives with Phase 3 telemetry.

### 3.4 Lost key recovery

1. User visits `billing.urateams.com/recover`, enters email.
2. Worker calls `stripe.customers.list({ email })`. If zero matches, returns a generic "if an account exists, we've sent a link" response (prevents email enumeration).
3. If matched, generates token `t = random(32)`, HMAC-signs with `MAGIC_LINK_HMAC_SECRET`, writes `MAGIC_LINKS[t] = { customerId, expiresAt: now + 900 }` with KV TTL 900.
4. Sends recover email: `billing.urateams.com/recover/{t}`.
5. `GET /recover/:token`: verify HMAC → look up in `MAGIC_LINKS` (410 if absent / expired) → read `LICENSES[customerId]` → **pre-generate a Stripe Billing Portal URL** via `stripe.billingPortal.sessions.create({ customer, return_url: "billing.urateams.com/thanks" })` → render page with JWT in a code block, `.jwt` file download, and a **Manage billing** link pointing at the pre-generated portal URL.
6. **Delete** `MAGIC_LINKS[t]` after render (single-use).
7. Append `AUDIT` entries: `action: "recovered"` and `action: "portal-opened"`.

The portal URL is embedded directly in the recover success page. There is no separate `/portal` Worker route — Stripe handles the rest of the billing UX once the user clicks through. If the user sits on the page long enough for the portal session to expire, clicking the link surfaces Stripe's "session expired" page and they can re-run `/recover`.

### 3.6 A note on identity

The `organization` custom field lives in Stripe customer metadata, not in the JWT. The JWT's `sub` is `cus_xxx` only. Organization name is for support and invoicing context.

## 4. Error handling and observability

### 4.1 Stripe webhook validation

Every `POST /stripe/webhook` request verifies via `stripe.webhooks.constructEvent(rawBody, sigHeader, STRIPE_WEBHOOK_SECRET)`. Signature failure returns 400 with no body; Stripe retries. The payload is never trusted before verification.

`checkout.session.completed` wraps mint+email in try/catch. If Resend throws, the handler still returns 200 to Stripe (the key is in KV, customer can recover it) and logs the failure. **Never return 5xx after a successful mint** — that triggers Stripe retry and spuriously fires the idempotency guard.

### 4.2 Resend failures

- **Welcome email retry**: on Resend 5xx, enqueue to a Cloudflare Queue (or a simpler KV-backed retry list the cron drains). Three retries with 5 min / 1 hr / 6 hr backoff.
- **Renewal email failure**: the cron sees the key still un-renewed on the next daily run and retries. The user's existing key still works.
- **Magic-link email failure**: return 500 to the user with "couldn't send, try again in a minute". No retry queue — the user will re-click.

### 4.3 KV consistency

KV is eventually consistent (~60s global). Acceptable for all three namespaces:
- `LICENSES`: read-your-own-write within a single Worker is fast; no cross-region sync needed.
- `MAGIC_LINKS`: tokens are unguessable; a brief write-propagation delay only means the link works a moment after it's delivered.
- `AUDIT`: append-only, order isn't load-bearing.

All `MAGIC_LINKS` writes use `put(..., { expirationTtl: 900 })` as a safety net.

### 4.4 Rate limiting

- `/recover`: Cloudflare rate-limit rule, 5 requests per IP per hour. Prevents spam / enumeration.
- `/checkout`: Cloudflare default DDoS protection; Stripe Checkout handles payment-side abuse.
- `/admin/audit`: HTTP Basic Auth, no rate limit needed.

### 4.5 Observability

- **Logs**: Cloudflare Workers Logs, tailed via `wrangler tail` in dev. Optional forwarding to Axiom/Logtail deferred. Every handler logs `{ event, customerId, result }` with no secret material. Full JWTs and signing-key material never logged — only `sub` and `exp` claims.
- **Alerts**:
  - Cloudflare email alert on Worker 5xx rate >1%.
  - Stripe dashboard alert on webhook delivery failures.
  - Resend dashboard alert on bounce rate >5%.
- **Audit trail**: `AUDIT` KV + `/admin/audit` read route (HTTP Basic Auth) gives a support-friendly view of what happened for a given customerId.

### 4.6 Secret rotation

Documented in `docs/rotation.md`:

- **Signing key**: mint new Ed25519 keypair. This requires a small companion change in the urateam repo to `packages/core/src/license.ts` so `@urateam/core` embeds both old and new public keys and verifies against either — the current implementation embeds a single key. After all JWTs signed with the old key have expired (13 months), remove the old public key in a future urateam release. Customers need no action.
- **Stripe webhook secret**: rotate in Stripe dashboard, update Workers Secret, redeploy. Stripe supports a rotation window where both secrets validate for ~24h.
- **Resend API key**: rotate in dashboard, update Workers Secret, redeploy.

### 4.7 Tolerated failure modes

- Customer pays but welcome email bounces → they recover via `/recover`. The Stripe success page links to support as a final fallback.
- Stripe webhook replayed → idempotency guard prevents duplicate keys and duplicate emails.
- Signing key compromise → rotation procedure exists; BSL 1.1 gives legal recourse; scale at v1 is too low for this to be a realistic threat. Phase 3 telemetry will add real-time revocation.

## 5. Testing

### 5.1 Unit tests (Vitest)

- `jwt.ts` — sign/verify round-trip, expired rejection, wrong-issuer rejection, malformed payload rejection. Test keypair generated in test setup.
- `stripe-webhook.ts` — signature verification (happy path + wrong secret); handlers for `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted` with mocked event payloads; idempotency guard (second replay is no-op).
- `magic-link.ts` — HMAC token verify, expiry, single-use (second visit returns 410).
- `email-templates.ts` — snapshot tests for welcome, renewal, lapsed, recover emails.

### 5.2 Integration tests (Miniflare)

- End-to-end webhook: POST a signed `checkout.session.completed` payload → assert KV has the license, Resend mock called with right args, response 200.
- End-to-end recovery: `POST /recover` → assert email sent → `GET /recover/:token` → assert JWT returned + magic link deleted.
- Renewal cron: seed KV with license expiring in 7 days → invoke scheduled handler → assert new JWT + email sent.
- Idempotency: replay `checkout.session.completed` twice → assert one welcome email only.

### 5.3 Manual test harness

`scripts/manual-test.ts` + `stripe listen --forward-to localhost:8787/stripe/webhook`. Documented in `DEVELOPING.md`:
```
stripe trigger checkout.session.completed
stripe trigger invoice.paid
stripe trigger customer.subscription.deleted
```

Stripe test-mode keys in `.dev.vars` (gitignored).

### 5.4 CI (GitHub Actions)

Single workflow on every PR: lint → typecheck → unit tests → integration tests → `wrangler deploy --dry-run`. Branch protection requires it to pass before merge to `main`.

### 5.5 Deploy & smoke test

`deploy.yml` on push to `main` runs `wrangler deploy` and then `curl billing.urateams.com/health`. First real-world test: one $1 test product, assert welcome email arrives. No automated end-to-end "real purchase" test in prod.

### 5.6 Coverage targets

Enforced in CI:
- `jwt.ts`, `stripe-webhook.ts`, `magic-link.ts`: **100% line coverage** (security-critical).
- Everything else: best-effort, no floor.

### 5.7 Not tested

- Stripe's hosted checkout UX.
- Resend delivery infrastructure.
- Cloudflare Workers runtime behavior.

## 6. Implementation phases

This spec covers a single service. Build order within the `urateam-licensing` repo:

1. **Scaffold** (day 1) — Wrangler project, KV namespaces, secrets wired, `GET /health` live at `billing.urateams.com`. Empty pricing page deployed to Cloudflare Pages.
2. **JWT minter + Stripe webhook happy path** (days 2–3) — `/stripe/webhook` handles `checkout.session.completed`, mints JWT, writes KV. Unit + integration tests. No email yet.
3. **Resend wiring + welcome email** (day 4) — welcome template, Resend client, end-to-end with Stripe CLI test mode.
4. **Checkout endpoint + pricing page** (day 5) — `POST /checkout` + Buy Pro button on `urateams.com/pricing`. First stranger-can-buy-Pro milestone.
5. **Renewals: `invoice.paid` + daily cron** (days 6–7) — re-mint logic, renewal email, scheduled handler.
6. **Lapse handling: `customer.subscription.deleted`** (day 8) — lapsed email, audit entry.
7. **Recovery flow + magic links** (days 9–10) — `/recover` POST + GET, magic-link generation/verification, recover email template, single-use KV.
8. **Stripe Customer Portal integration** (day 11) — configure the portal in the Stripe dashboard (branding, cancel reasons, enabled features), integrate `stripe.billingPortal.sessions.create` into the `/recover/:token` handler so the success page embeds a pre-generated portal URL.
9. **Admin audit route + rotation docs** (day 12) — `/admin/audit` with Basic Auth, `docs/rotation.md`, `docs/OPERATIONS.md`.
10. **First live purchase smoke test** (day 13) — real $1 test product, verify full loop, fix whatever breaks, remove test product.

Two-and-a-half weeks of focused solo work. Spec § 6 Phase 1 in the tier design said "~1 week"; that was optimistic. The Worker is ~1 week, but the full scope here (pricing page, portal, recovery, observability, CI) pushes it to 2–3.

## 7. Open questions

Deferred to build-time or to go-to-market work, not blockers:

- **Pro price point in dollars** — GTM decision. The Stripe price id is the only code dependency; can be swapped post-launch via Wrangler secret update.
- **Annual plan** — add post-launch. Requires a second price id and a `plan` hint in the Stripe metadata so renewal cadence logic knows whether to compare to 12-month or 1-month cycles.
- **`urateams.com` marketing site beyond `/pricing`** — out of scope; adding a richer landing page is a separate project.
- **Receipts / tax handling** — Stripe Checkout handles receipts automatically and Stripe Tax can be enabled later without code changes.

## 8. Out of scope (explicitly deferred)

- **Seat enforcement** in the urateam dashboard (JWT `seats` is currently informational; enforcement is a separate change in the urateam repo).
- **License revocation / real-time validation** — Phase 3 telemetry per tier design spec § 5.1.
- **Coupons, discounts, free trials** — add when GTM requires.
- **Self-serve Enterprise purchase** — Enterprise stays sales-led per the tier design spec § 3.
- **Custom contracts / MSA / negotiation flow** — Enterprise track.
- **Multi-org-per-customer** — one Stripe customer = one org in v1.
- **Team billing management UI beyond Stripe Portal** — Stripe Portal is sufficient.
- **Migrating existing urateam design-partner customers onto Stripe** — manual data seeding (one-off KV writes via Wrangler) handles the current handful of hand-minted keys.

---

**Next**: after review, invoke the writing-plans skill to turn this into an executable implementation plan, then stand up the `urateam-licensing` repo.
