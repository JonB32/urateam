# urateam-licensing Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the standalone `urateam-licensing` service — a Cloudflare Worker at `billing.urateams.com` that mints, emails, and re-delivers Pro-tier license JWTs in response to Stripe subscription events, with a minimal static pricing page at `urateams.com/pricing`.

**Architecture:** Single Cloudflare Worker + Cloudflare Pages (both deployed from the same private GitHub repo), three KV namespaces (`LICENSES`, `MAGIC_LINKS`, `AUDIT`), offline Ed25519 JWT signing. Spec: `docs/superpowers/specs/2026-04-17-urateam-licensing-phase2-design.md`.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler 3.x, Vitest + Miniflare for tests, `jose` for JWT (EdDSA/Ed25519), `stripe` npm package with `constructEventAsync` for webhook verification, Resend for email, Node 20 LTS on CI.

---

## File structure (new repo)

```
urateam-licensing/                        (new private GitHub repo)
├── worker/
│   ├── src/
│   │   ├── index.ts                 # router, env type, default + scheduled export
│   │   ├── routes/
│   │   │   ├── checkout.ts          # POST /checkout
│   │   │   ├── webhook.ts           # POST /stripe/webhook
│   │   │   ├── recover.ts           # POST /recover, GET /recover/:token
│   │   │   └── admin.ts             # GET /admin/audit (HTTP Basic Auth)
│   │   ├── lib/
│   │   │   ├── jwt.ts               # sign(), verify() — Ed25519 via jose
│   │   │   ├── stripe.ts            # constructEventAsync + typed event handlers
│   │   │   ├── email.ts             # Resend client + sendWelcome/Renewal/Lapsed/Recover
│   │   │   ├── magic-link.ts        # HMAC token mint + verify
│   │   │   └── kv.ts                # LicenseRecord, AuditEntry, helpers
│   │   ├── templates/
│   │   │   ├── welcome.ts           # HTML + plaintext string builders
│   │   │   ├── renewal.ts
│   │   │   ├── lapsed.ts
│   │   │   ├── recover.ts           # magic-link email
│   │   │   └── recover-page.ts      # the GET /recover/:token HTML page
│   │   └── scheduled.ts             # daily cron handler (renewal sweep)
│   ├── test/
│   │   ├── jwt.test.ts
│   │   ├── stripe-webhook.test.ts
│   │   ├── checkout-completed.test.ts  # webhook handler: JWT mint + KV write
│   │   ├── invoice-paid.test.ts        # renewal handler
│   │   ├── subscription-deleted.test.ts # lapse handler
│   │   ├── magic-link.test.ts
│   │   ├── email-templates.test.ts
│   │   ├── checkout.test.ts            # POST /checkout route
│   │   ├── recover-post.test.ts        # POST /recover
│   │   ├── recover-get.test.ts         # GET /recover/:token
│   │   ├── admin.test.ts
│   │   ├── scheduled.test.ts
│   │   └── setup.ts                    # test keypair + Miniflare KV harness
│   ├── wrangler.toml
│   ├── vitest.config.ts
│   ├── tsconfig.json
│   ├── package.json
│   └── .dev.vars.example
├── pages/
│   ├── index.html                   # minimal landing
│   ├── pricing.html                 # Buy Pro button
│   └── thanks.html                  # post-checkout success
├── scripts/
│   ├── gen-signing-key.ts           # one-time Ed25519 keypair generator
│   └── manual-test.ts               # stripe CLI harness notes
├── docs/
│   ├── DEVELOPING.md
│   ├── OPERATIONS.md
│   └── rotation.md
├── .github/workflows/
│   ├── ci.yml                       # lint + typecheck + test + wrangler dry-run
│   └── deploy.yml                   # prod deploy on push to main
├── .gitignore
├── LICENSE
└── README.md
```

## PR grouping

| PR | Repo | Tasks | Outcome |
|---|---|---|---|
| **PR 0 — Issuer cutover** | urateam | -1 | `ISSUER = "urateams.com"` in `packages/core/src/license.ts`; test + release. Prerequisite for minting real JWTs. |
| **PR 1 — Bootstrap** | urateam-licensing | 0 | Repo + Wrangler + /health + CI + Pages scaffold |
| **PR 2 — JWT + webhook happy path** | urateam-licensing | 1–4 | `checkout.session.completed` mints a JWT, writes KV, idempotent |
| **PR 3 — Email + checkout + pricing page** | urateam-licensing | 5–8 | Stranger can buy Pro and receive a working key |
| **PR 4 — Renewals + lapse** | urateam-licensing | 9–11 | Monthly renewal, 14-day-out cron, lapsed email |
| **PR 5 — Recovery + portal** | urateam-licensing | 12–14 | Lost-key flow + Stripe Customer Portal integration |
| **PR 6 — Admin + docs + smoke test** | urateam-licensing | 15–17 | `/admin/audit`, operations docs, first real-world $1 test |

Per-PR workflow (proven in Phase 1): branch from `main` → build + test locally → push → open PR → invoke `review` skill with Sonnet subagent → land review fixes → merge.

---

## Task -1: ISSUER cutover in urateam repo (prerequisite)

**Purpose:** Change the JWT-verifier's expected issuer from `"urateam.dev"` to `"urateams.com"` so licenses minted by Phase 2 Worker will validate against `@urateam/core` in customer installations. Must merge and release **before** Task 0 wires up real Stripe traffic.

**Repo:** urateam (the current monorepo).

**Files:**
- Modify: `packages/core/src/license.ts:149`
- Modify: `packages/core/src/__tests__/license.test.ts` (or wherever license tests live — check)

- [ ] **Step 1: Create worktree + branch from main**

```bash
cd /private/tmp/urateam
git worktree add .worktrees/issuer-cutover -b chore/issuer-urateams-com main
cd .worktrees/issuer-cutover
pnpm install
```

- [ ] **Step 2: Check where the existing license tests live**

```bash
grep -rn "urateam\.dev" packages/core/src/
```
Expect: `packages/core/src/license.ts:149: const ISSUER = "urateam.dev";` plus any hardcoded test fixtures.

- [ ] **Step 3: Change ISSUER constant**

In `packages/core/src/license.ts`:
```ts
const ISSUER = "urateams.com";
```

- [ ] **Step 4: Update any test fixtures**

Any test JWT fixtures that hardcode `"iss": "urateam.dev"` get flipped to `"urateams.com"`.

- [ ] **Step 5: Run tests**

```bash
cd packages/core && npx vitest run
```
Expected: all pass. If any fail, they either reference the old issuer string (update them) or depend on a feature unrelated to license verification (real bug — investigate).

- [ ] **Step 6: Build**

```bash
cd /private/tmp/urateam/.worktrees/issuer-cutover
pnpm build
```

- [ ] **Step 7: Commit, push, PR**

```bash
git add packages/core/src/license.ts packages/core/src/__tests__
git commit -m "chore: rename license issuer from urateam.dev to urateams.com

Phase 2 billing Worker mints JWTs with iss=urateams.com to match
the canonical commercial domain. No paying Pro customers exist yet,
so this is a clean cutover without back-compat shims."
git push -u origin chore/issuer-urateams-com
gh pr create --title "chore: rename license issuer to urateams.com" --body "Prereq for Phase 2 billing Worker. Flips the JWT ISSUER constant so @urateam/core can verify licenses minted by the upcoming billing service."
```

- [ ] **Step 8: Invoke `review` skill with Sonnet subagent, land fixes, merge**

- [ ] **Step 9: Publish a new `@urateam/core` release with the updated ISSUER**

(If the repo has a release workflow, kick it off. Otherwise, bump the version in `packages/core/package.json`, `pnpm build`, and publish.)

- [ ] **Step 10: Remove the worktree**

```bash
cd /private/tmp/urateam
git worktree remove .worktrees/issuer-cutover
```

---

---

## Task 0: Bootstrap `urateam-licensing` repo

**Purpose:** Create the repo, wire Wrangler + Cloudflare Pages + CI, deploy an empty `/health` route to prove the pipeline works end-to-end.

**Files:**
- Create: `urateam-licensing/` (new repo root — local clone path chosen by operator, e.g. `~/code/urateam-licensing`)
- Create: `worker/package.json`, `worker/tsconfig.json`, `worker/wrangler.toml`, `worker/vitest.config.ts`, `worker/src/index.ts`, `worker/test/setup.ts`, `worker/.dev.vars.example`
- Create: `pages/index.html`, `pages/pricing.html`, `pages/thanks.html`
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`
- Create: `scripts/gen-signing-key.ts`
- Create: `.gitignore`, `LICENSE` (MIT — this is tooling, not the urateam product), `README.md`

**Test:** `worker/test/index.test.ts`

- [ ] **Step 1: Create the GitHub repo (private) and clone**

```bash
gh repo create JonB32/urateam-licensing --private --description "License minting + billing for urateam Pro"
gh repo clone JonB32/urateam-licensing ~/code/urateam-licensing
cd ~/code/urateam-licensing
```

- [ ] **Step 2: Write `.gitignore` and `README.md`**

`.gitignore`:
```
node_modules/
.wrangler/
dist/
.dev.vars
*.log
.DS_Store
```

`README.md` (minimal — operator-facing):
```markdown
# urateam-licensing

License minting + billing service for urateam Pro. See `docs/superpowers/specs/2026-04-17-urateam-licensing-phase2-design.md` in the urateam repo for the design.

## Quickstart
- `pnpm install` (in `worker/`)
- `pnpm test` — unit + integration tests
- `pnpm dev` — local Miniflare with Stripe CLI forwarding (see `docs/DEVELOPING.md`)

## Deploy
Production deploys from `main` via GitHub Actions. See `docs/OPERATIONS.md`.
```

- [ ] **Step 3: Scaffold `worker/package.json`**

```json
{
  "name": "@urateam/licensing-worker",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --port 8787",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src test"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20260101.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@types/node": "^20.11.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.57.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "wrangler": "^3.50.0"
  },
  "dependencies": {
    "jose": "^5.2.0",
    "stripe": "^14.21.0",
    "resend": "^3.2.0"
  }
}
```

- [ ] **Step 4: `worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 5: `worker/wrangler.toml`**

```toml
name = "urateam-licensing"
main = "src/index.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

account_id = "REPLACE_WITH_CF_ACCOUNT_ID"

[[kv_namespaces]]
binding = "LICENSES"
id = "REPLACE_AFTER_CREATING"

[[kv_namespaces]]
binding = "MAGIC_LINKS"
id = "REPLACE_AFTER_CREATING"

[[kv_namespaces]]
binding = "AUDIT"
id = "REPLACE_AFTER_CREATING"

[triggers]
crons = ["0 6 * * *"]

[vars]
STRIPE_PRO_PRICE_ID = "price_REPLACE_IN_CF_DASHBOARD"

# Secrets set via `wrangler secret put`:
#   SIGNING_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
#   RESEND_API_KEY, MAGIC_LINK_HMAC_SECRET, ADMIN_BASIC_AUTH

[[routes]]
pattern = "billing.urateams.com/*"
zone_name = "urateams.com"
```

- [ ] **Step 6: `worker/.dev.vars.example`**

```
SIGNING_KEY="-----BEGIN PRIVATE KEY-----\n...generated via scripts/gen-signing-key.ts...\n-----END PRIVATE KEY-----"
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
RESEND_API_KEY="re_..."
MAGIC_LINK_HMAC_SECRET="hex-encoded-32-bytes"
ADMIN_BASIC_AUTH="admin:$2a$10$bcrypt_hash_here"
STRIPE_PRO_PRICE_ID="price_..."
```

- [ ] **Step 7: `worker/src/index.ts`** (router with /health only)

```ts
export interface Env {
  LICENSES: KVNamespace;
  MAGIC_LINKS: KVNamespace;
  AUDIT: KVNamespace;
  SIGNING_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  MAGIC_LINK_HMAC_SECRET: string;
  ADMIN_BASIC_AUTH: string;
  STRIPE_PRO_PRICE_ID: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return new Response("ok", { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // filled in Task 10
  },
};
```

- [ ] **Step 8: `worker/vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          kvNamespaces: ["LICENSES", "MAGIC_LINKS", "AUDIT"],
          bindings: {
            SIGNING_KEY: "", // populated per-test in setup.ts
            STRIPE_SECRET_KEY: "sk_test_dummy",
            STRIPE_WEBHOOK_SECRET: "whsec_dummy",
            RESEND_API_KEY: "re_dummy",
            MAGIC_LINK_HMAC_SECRET: "00".repeat(32),
            ADMIN_BASIC_AUTH: "admin:$2a$10$dummy",
            STRIPE_PRO_PRICE_ID: "price_test",
          },
        },
      },
    },
  },
});
```

- [ ] **Step 9: `worker/test/index.test.ts` — failing test for `/health`**

```ts
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("router", () => {
  it("returns ok on GET /health", async () => {
    const env = {} as any;
    const ctx = {} as any;
    const res = await worker.fetch(new Request("https://billing.urateams.com/health"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown paths", async () => {
    const env = {} as any;
    const ctx = {} as any;
    const res = await worker.fetch(new Request("https://billing.urateams.com/nope"), env, ctx);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 10: `pnpm install` and run tests**

```bash
cd worker && pnpm install && pnpm test
```
Expected: both tests pass.

- [ ] **Step 11: Write `scripts/gen-signing-key.ts`** (generates Ed25519 keypair for SIGNING_KEY secret)

```ts
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";

const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const privPem = await exportPKCS8(privateKey);
const pubPem = await exportSPKI(publicKey);

console.log("=== PRIVATE KEY (paste into Workers Secret SIGNING_KEY) ===");
console.log(privPem);
console.log("=== PUBLIC KEY (embed in @urateam/core license.ts) ===");
console.log(pubPem);
```

Run once and store both halves; private → `wrangler secret put SIGNING_KEY`, public → tracked in the urateam repo.

- [ ] **Step 12: Write CI workflow `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: worker
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm, cache-dependency-path: worker/pnpm-lock.yaml }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm exec wrangler deploy --dry-run
```

- [ ] **Step 13: Write deploy workflow `.github/workflows/deploy.yml`**

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy-worker:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: worker } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm, cache-dependency-path: worker/pnpm-lock.yaml }
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: worker
      - name: Smoke test
        run: curl --fail --retry 3 --retry-delay 5 https://billing.urateams.com/health

  deploy-pages:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Publish to Cloudflare Pages
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: urateam-site
          directory: pages
```

- [ ] **Step 14: Write `pages/index.html`, `pages/pricing.html`, `pages/thanks.html` (placeholders for now)**

`pages/pricing.html`:
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>urateam — Pricing</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-white text-slate-900"><main class="max-w-3xl mx-auto p-8">
<h1 class="text-4xl font-bold">Pricing</h1>
<p class="mt-4 text-lg">Pro — coming soon. Buy button wired in Task 8.</p>
</main></body></html>
```

(Similarly-brief `index.html` and `thanks.html` placeholders.)

- [ ] **Step 15: Create KV namespaces on Cloudflare and update `wrangler.toml`**

```bash
cd worker
pnpm exec wrangler kv:namespace create LICENSES
pnpm exec wrangler kv:namespace create MAGIC_LINKS
pnpm exec wrangler kv:namespace create AUDIT
```
Paste the returned `id` values into `wrangler.toml`.

- [ ] **Step 16: Set a dummy secret so the deploy succeeds**

```bash
pnpm exec wrangler secret put SIGNING_KEY  # paste output from gen-signing-key.ts
# (other secrets can remain unset — the /health route doesn't read them)
```

- [ ] **Step 17: Commit and open PR 1**

```bash
git add -A
git commit -m "chore: bootstrap urateam-licensing Worker + Pages scaffold"
git push -u origin main
```
(Operator pushes directly to main for the bootstrap commit since there's no prior main to branch from; subsequent PRs branch from main as normal.)

Deploy workflow runs, `GET https://billing.urateams.com/health` returns `ok`. Smoke test green. Bootstrap complete.

---

## Task 1: JWT mint + verify library

**Files:**
- Create: `worker/src/lib/jwt.ts`
- Test: `worker/test/jwt.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// worker/test/jwt.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import { signLicense, verifyLicense, LicenseClaims } from "../src/lib/jwt";

let privPem: string;
let pubPem: string;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  privPem = await exportPKCS8(privateKey);
  pubPem = await exportSPKI(publicKey);
});

describe("jwt", () => {
  it("signs and verifies a Pro license", async () => {
    const jwt = await signLicense(privPem, { sub: "cus_123", tier: "pro", seats: 25 });
    const claims = await verifyLicense(pubPem, jwt);
    expect(claims.sub).toBe("cus_123");
    expect(claims.tier).toBe("pro");
    expect(claims.seats).toBe(25);
    expect(claims.iss).toBe("urateams.com");
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("sets exp to ~13 months out", async () => {
    const jwt = await signLicense(privPem, { sub: "cus_123", tier: "pro", seats: 25 });
    const claims = await verifyLicense(pubPem, jwt);
    const thirteenMonthsSec = 13 * 30 * 86400;
    const actualOffset = claims.exp - claims.iat;
    expect(Math.abs(actualOffset - thirteenMonthsSec)).toBeLessThan(60);
  });

  it("rejects wrong issuer", async () => {
    const jwt = await signLicense(privPem, { sub: "cus_x", tier: "pro", seats: 25 }, { iss: "evil.com" });
    await expect(verifyLicense(pubPem, jwt)).rejects.toThrow();
  });

  it("rejects expired tokens", async () => {
    const jwt = await signLicense(privPem, { sub: "cus_x", tier: "pro", seats: 25 }, { expSecondsFromNow: -1 });
    await expect(verifyLicense(pubPem, jwt)).rejects.toThrow();
  });

  it("rejects tampered signature", async () => {
    const jwt = await signLicense(privPem, { sub: "cus_x", tier: "pro", seats: 25 });
    const tampered = jwt.slice(0, -5) + "AAAAA";
    await expect(verifyLicense(pubPem, tampered)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

```bash
cd worker && pnpm test jwt
```
Expected: fails (module doesn't exist).

- [ ] **Step 3: Implement `worker/src/lib/jwt.ts`**

```ts
import { SignJWT, jwtVerify, importPKCS8, importSPKI } from "jose";

export interface LicenseClaims {
  iss: string;
  sub: string;
  tier: "pro" | "enterprise";
  seats: number | null;
  iat: number;
  exp: number;
}

interface SignInput {
  sub: string;
  tier: "pro" | "enterprise";
  seats: number | null;
}

interface SignOptions {
  iss?: string;
  expSecondsFromNow?: number; // override for testing
}

const THIRTEEN_MONTHS_SEC = 13 * 30 * 86400;

export async function signLicense(
  privatePem: string,
  input: SignInput,
  opts: SignOptions = {},
): Promise<string> {
  const key = await importPKCS8(privatePem, "EdDSA");
  const iss = opts.iss ?? "urateams.com";
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.expSecondsFromNow ?? THIRTEEN_MONTHS_SEC);
  return await new SignJWT({ tier: input.tier, seats: input.seats })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(iss)
    .setSubject(input.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);
}

export async function verifyLicense(publicPem: string, jwt: string): Promise<LicenseClaims> {
  const key = await importSPKI(publicPem, "EdDSA");
  const { payload } = await jwtVerify(jwt, key, { issuer: "urateams.com" });
  return payload as unknown as LicenseClaims;
}
```

- [ ] **Step 4: Run tests — expect all 5 to pass**

```bash
pnpm test jwt
```

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/jwt-lib
git add worker/src/lib/jwt.ts worker/test/jwt.test.ts
git commit -m "feat: Ed25519 license JWT sign + verify"
```

---

## Task 2: Stripe webhook signature verification

**Files:**
- Create: `worker/src/lib/stripe.ts`
- Test: `worker/test/stripe-webhook.test.ts`

- [ ] **Step 1: Write failing tests for signature verification**

```ts
// worker/test/stripe-webhook.test.ts (first round — sig only)
import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { verifyStripeWebhook } from "../src/lib/stripe";

const SECRET = "whsec_test_secret_12345";

function signPayload(payload: string, secret: string, timestamp: number): string {
  // Use Stripe SDK's own helper to construct a valid signature header for tests.
  return (Stripe as any).webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

describe("verifyStripeWebhook", () => {
  it("accepts a valid signature", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(body, SECRET, ts);
    const event = await verifyStripeWebhook(body, sig, SECRET);
    expect(event.type).toBe("checkout.session.completed");
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(body, SECRET, ts);
    await expect(verifyStripeWebhook(body + "x", sig, SECRET)).rejects.toThrow();
  });

  it("rejects wrong secret", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(body, SECRET, ts);
    await expect(verifyStripeWebhook(body, sig, "whsec_wrong")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/lib/stripe.ts`**

```ts
import Stripe from "stripe";

export function getStripe(env: { STRIPE_SECRET_KEY: string }): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export async function verifyStripeWebhook(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<Stripe.Event> {
  // Workers require the async variant because they use WebCrypto (no node crypto sync).
  const stripe = new Stripe("sk_test_dummy_only_for_sig_verify", {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });
  return await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/stripe.ts worker/test/stripe-webhook.test.ts
git commit -m "feat: Stripe webhook signature verification"
```

---

## Task 3: KV helpers + types

**Files:**
- Create: `worker/src/lib/kv.ts`
- Test: `worker/test/kv.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// worker/test/kv.test.ts
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { readLicense, writeLicense, appendAudit, LicenseRecord } from "../src/lib/kv";

describe("kv", () => {
  it("round-trips a license record", async () => {
    const rec: LicenseRecord = {
      stripeSubscriptionId: "sub_1",
      currentJwt: "eyJ.fake.jwt",
      issuedAt: 1000,
      expiresAt: 2000,
      email: "a@b.com",
      organization: "Acme",
    };
    await writeLicense(env.LICENSES, "cus_1", rec);
    const got = await readLicense(env.LICENSES, "cus_1");
    expect(got).toEqual(rec);
  });

  it("returns null for missing customer", async () => {
    expect(await readLicense(env.LICENSES, "cus_missing")).toBeNull();
  });

  it("appendAudit writes a retrievable entry", async () => {
    await appendAudit(env.AUDIT, "cus_1", { action: "issued", ip: "1.2.3.4", userAgent: "test" });
    const list = await env.AUDIT.list({ prefix: "cus_1:" });
    expect(list.keys.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/lib/kv.ts`**

```ts
export interface LicenseRecord {
  stripeSubscriptionId: string;
  currentJwt: string;
  issuedAt: number;
  expiresAt: number;
  email: string;
  organization: string;
}

export type AuditAction = "issued" | "renewed" | "recovered" | "lapsed" | "portal-opened";

export interface AuditEntry {
  action: AuditAction;
  ip: string;
  userAgent: string;
}

export async function readLicense(kv: KVNamespace, customerId: string): Promise<LicenseRecord | null> {
  return await kv.get<LicenseRecord>(customerId, "json");
}

export async function writeLicense(kv: KVNamespace, customerId: string, rec: LicenseRecord): Promise<void> {
  await kv.put(customerId, JSON.stringify(rec));
}

export async function appendAudit(kv: KVNamespace, customerId: string, entry: AuditEntry): Promise<void> {
  const ts = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const key = `${customerId}:${ts}`;
  // 1-year TTL = 31_536_000s
  await kv.put(key, JSON.stringify(entry), { expirationTtl: 31_536_000 });
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit**

```bash
git add worker/src/lib/kv.ts worker/test/kv.test.ts
git commit -m "feat: KV helpers for LICENSES + AUDIT"
```

---

## Task 4: `checkout.session.completed` handler (JWT mint + KV write, idempotent)

**Files:**
- Create: `worker/src/routes/webhook.ts`
- Modify: `worker/src/index.ts` (wire route)
- Test: `worker/test/checkout-completed.test.ts`

- [ ] **Step 1: Write failing integration test**

```ts
// worker/test/checkout-completed.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import Stripe from "stripe";
import worker from "../src/index";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import { verifyLicense } from "../src/lib/jwt";

let privPem: string;
let pubPem: string;

function makeEvent(customerId: string, subId: string, email: string, org: string): string {
  const event: any = {
    id: "evt_" + Math.random().toString(36).slice(2),
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        customer: customerId,
        subscription: subId,
        customer_email: email,
        custom_fields: [{ key: "organization", text: { value: org } }],
      },
    },
  };
  return JSON.stringify(event);
}

function signHeader(body: string, secret: string): string {
  return (Stripe as any).webhooks.generateTestHeaderString({
    payload: body, secret, timestamp: Math.floor(Date.now() / 1000),
  });
}

beforeEach(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  privPem = await exportPKCS8(privateKey);
  pubPem = await exportSPKI(publicKey);
  (env as any).SIGNING_KEY = privPem;
  (env as any).STRIPE_WEBHOOK_SECRET = "whsec_test";
});

describe("POST /stripe/webhook — checkout.session.completed", () => {
  it("mints a JWT, writes KV, appends audit", async () => {
    const body = makeEvent("cus_abc", "sub_abc", "ops@acme.com", "Acme Corp");
    const sig = signHeader(body, "whsec_test");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": sig, "content-type": "application/json" },
        body,
      }),
      env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const rec = await env.LICENSES.get("cus_abc", "json") as any;
    expect(rec).toBeTruthy();
    expect(rec.stripeSubscriptionId).toBe("sub_abc");
    expect(rec.email).toBe("ops@acme.com");
    expect(rec.organization).toBe("Acme Corp");

    const claims = await verifyLicense(pubPem, rec.currentJwt);
    expect(claims.sub).toBe("cus_abc");
    expect(claims.tier).toBe("pro");
    expect(claims.seats).toBe(25);

    const audit = await env.AUDIT.list({ prefix: "cus_abc:" });
    expect(audit.keys.length).toBeGreaterThan(0);
  });

  it("is idempotent on replay", async () => {
    const body = makeEvent("cus_dup", "sub_dup", "a@b.com", "Dup Co");
    const sig = signHeader(body, "whsec_test");
    const fire = async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request("https://billing.urateams.com/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": sig, "content-type": "application/json" },
          body,
        }),
        env as any, ctx,
      );
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    expect(await fire()).toBe(200);
    const first = await env.LICENSES.get("cus_dup", "json") as any;
    expect(await fire()).toBe(200);
    const second = await env.LICENSES.get("cus_dup", "json") as any;
    expect(second.currentJwt).toBe(first.currentJwt); // not re-minted
  });

  it("rejects bad signature with 400", async () => {
    const body = makeEvent("cus_bad", "sub_bad", "x@y.com", "X");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
        body,
      }),
      env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/routes/webhook.ts`**

```ts
import Stripe from "stripe";
import type { Env } from "../index";
import { verifyStripeWebhook } from "../lib/stripe";
import { signLicense } from "../lib/jwt";
import { readLicense, writeLicense, appendAudit, LicenseRecord } from "../lib/kv";

export async function handleStripeWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const sig = request.headers.get("stripe-signature") ?? "";
  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = await verifyStripeWebhook(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return new Response("bad signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event, env, request);
        break;
      // invoice.paid → Task 9; customer.subscription.deleted → Task 11
    }
  } catch (err) {
    console.error("webhook_handler_error", { type: event.type, err: String(err) });
    // Still return 200 if the mint+KV write succeeded before email failed; see Task 6.
  }

  return new Response("ok", { status: 200 });
}

async function handleCheckoutCompleted(event: Stripe.Event, env: Env, request: Request): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const email = session.customer_email ?? session.customer_details?.email ?? "";
  const organization = (session.custom_fields ?? [])
    .find(f => f.key === "organization")?.text?.value ?? "";

  if (!customerId || !subscriptionId) {
    console.warn("checkout_session_missing_ids", { sessionId: session.id });
    return;
  }

  // Idempotency: if we already have a record for this customer with the same subscription id, skip.
  const existing = await readLicense(env.LICENSES, customerId);
  if (existing?.stripeSubscriptionId === subscriptionId) {
    console.info("checkout_replay_skipped", { customerId });
    return;
  }

  const jwt = await signLicense(env.SIGNING_KEY, { sub: customerId, tier: "pro", seats: 25 });
  const now = Math.floor(Date.now() / 1000);
  const rec: LicenseRecord = {
    stripeSubscriptionId: subscriptionId,
    currentJwt: jwt,
    issuedAt: now,
    expiresAt: now + 13 * 30 * 86400,
    email,
    organization,
  };
  await writeLicense(env.LICENSES, customerId, rec);
  await appendAudit(env.AUDIT, customerId, {
    action: "issued",
    ip: request.headers.get("cf-connecting-ip") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  });

  // Welcome email dispatch added in Task 6.
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
// Add to fetch():
if (url.pathname === "/stripe/webhook" && request.method === "POST") {
  return await handleStripeWebhook(request, env, ctx);
}
```
(with `import { handleStripeWebhook } from "./routes/webhook";` at top)

- [ ] **Step 5: Run tests — expect pass**

```bash
pnpm test checkout-completed
```

- [ ] **Step 6: Commit and open PR 2**

```bash
git add -A
git commit -m "feat: checkout.session.completed handler mints JWT + writes KV"
git push -u origin feat/jwt-lib
gh pr create --title "PR 2: JWT + webhook happy path" --body "Closes milestone PR 2 of implementation plan. Mints a Pro JWT on checkout.session.completed with idempotency."
```

Invoke `review` skill with Sonnet subagent. Land fixes. Merge.

---

## Task 5: Resend email client + welcome template

**Files:**
- Create: `worker/src/lib/email.ts`
- Create: `worker/src/templates/welcome.ts`
- Test: `worker/test/email-templates.test.ts`

- [ ] **Step 1: Write failing tests for template + client**

```ts
// worker/test/email-templates.test.ts
import { describe, expect, it, vi } from "vitest";
import { renderWelcome } from "../src/templates/welcome";
import { sendEmail } from "../src/lib/email";

describe("renderWelcome", () => {
  it("renders JWT and instructions", () => {
    const out = renderWelcome({ email: "a@b.com", organization: "Acme", jwt: "eyJfake" });
    expect(out.subject).toMatch(/Pro license key/i);
    expect(out.html).toContain("eyJfake");
    expect(out.html).toContain("URATEAM_LICENSE_KEY");
    expect(out.text).toContain("eyJfake");
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].filename).toMatch(/urateam-license\.jwt/);
  });
});

describe("sendEmail", () => {
  it("POSTs to Resend with correct shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    globalThis.fetch = fetchMock as any;
    await sendEmail("re_key", {
      to: "a@b.com",
      subject: "hi",
      html: "<p>hi</p>",
      text: "hi",
      attachments: [{ filename: "license.jwt", content: "eyJ..." }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("https://api.resend.com/emails");
    const init = call[1] as RequestInit;
    expect((init.headers as any).Authorization).toBe("Bearer re_key");
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe("a@b.com");
    expect(body.subject).toBe("hi");
    expect(body.attachments).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/lib/email.ts`**

```ts
export interface EmailAttachment {
  filename: string;
  content: string; // base64 or plaintext; Resend accepts plaintext with content-type inferred from extension
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export async function sendEmail(apiKey: string, msg: EmailMessage): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "urateam <hello@urateams.com>",
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments,
    }),
  });
  if (!res.ok) {
    throw new Error(`resend_error status=${res.status} body=${await res.text()}`);
  }
}
```

- [ ] **Step 4: Implement `worker/src/templates/welcome.ts`**

```ts
export interface WelcomeInput {
  email: string;
  organization: string;
  jwt: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: string }[];
}

export function renderWelcome(input: WelcomeInput): RenderedEmail {
  const subject = "Your urateam Pro license key";
  const html = `
    <p>Welcome to urateam Pro${input.organization ? `, ${input.organization}` : ""}.</p>
    <p>Your license key is attached and shown below. Set it as an env var:</p>
    <pre><code>export URATEAM_LICENSE_KEY="${input.jwt}"</code></pre>
    <p>Need help? Reply to this email.</p>
  `;
  const text = `Welcome to urateam Pro.

Your license key:

${input.jwt}

Set it as an env var:
  export URATEAM_LICENSE_KEY="${input.jwt}"

Need help? Reply to this email.`;
  return {
    subject,
    html,
    text,
    attachments: [{ filename: "urateam-license.jwt", content: btoa(input.jwt) }],
  };
}
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/email-checkout
git add worker/src/lib/email.ts worker/src/templates/welcome.ts worker/test/email-templates.test.ts
git commit -m "feat: Resend client + welcome email template"
```

---

## Task 6: Wire welcome email into `checkout.session.completed`

**Files:**
- Modify: `worker/src/routes/webhook.ts`
- Modify: `worker/test/checkout-completed.test.ts`

- [ ] **Step 1: Extend test to assert email was sent**

Add to the existing `"mints a JWT..."` test — mock `fetch` before the call and assert Resend was hit:

```ts
// at top of the test body:
const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
// ...after the existing assertions:
expect(fetchSpy).toHaveBeenCalled();
const resendCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("resend.com"));
expect(resendCall).toBeTruthy();
const body = JSON.parse((resendCall![1] as RequestInit).body as string);
expect(body.to).toBe("ops@acme.com");
expect(body.subject).toMatch(/Pro license key/i);
```

- [ ] **Step 2: Run — expect failure (no email dispatched yet)**

- [ ] **Step 3: Add email dispatch in webhook handler**

In `handleCheckoutCompleted`, after `appendAudit(...)`:

```ts
try {
  const { renderWelcome } = await import("../templates/welcome");
  const { sendEmail } = await import("../lib/email");
  const rendered = renderWelcome({ email, organization, jwt });
  await sendEmail(env.RESEND_API_KEY, { to: email, ...rendered });
} catch (err) {
  console.error("welcome_email_failed", { customerId, err: String(err) });
  // Swallow — the JWT is in KV; customer can recover. Never 5xx back to Stripe.
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: send welcome email after successful checkout"
```

---

## Task 7: `POST /checkout` route (Stripe Checkout Session)

**Files:**
- Create: `worker/src/routes/checkout.ts`
- Modify: `worker/src/index.ts` (wire route)
- Test: `worker/test/checkout.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// worker/test/checkout.test.ts
import { describe, expect, it, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

describe("POST /checkout", () => {
  it("creates a Stripe session and 303s to its URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("api.stripe.com/v1/checkout/sessions")) {
        return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/pay/cs_test_1" }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/checkout", { method: "POST" }),
      env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://checkout.stripe.com/pay/cs_test_1");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/routes/checkout.ts`**

```ts
import type { Env } from "../index";
import { getStripe } from "../lib/stripe";

export async function handleCheckout(_request: Request, env: Env): Promise<Response> {
  const stripe = getStripe(env);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
    custom_fields: [{
      key: "organization",
      label: { type: "custom", custom: "Organization name" },
      type: "text",
    }],
    client_reference_id: crypto.randomUUID(),
    success_url: "https://urateams.com/thanks?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "https://urateams.com/pricing",
    allow_promotion_codes: false,
  });
  if (!session.url) {
    return new Response("stripe did not return a url", { status: 502 });
  }
  return Response.redirect(session.url, 303);
}
```

- [ ] **Step 4: Wire in `src/index.ts`**

```ts
if (url.pathname === "/checkout" && request.method === "POST") {
  return await handleCheckout(request, env);
}
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: POST /checkout creates Stripe Checkout Session"
```

---

## Task 8: Pricing page with Buy Pro button

**Files:**
- Modify: `pages/pricing.html`

- [ ] **Step 1: Replace pricing page with real copy + form**

```html
<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>urateam — Pricing</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-white text-slate-900">
<main class="max-w-3xl mx-auto p-8">
  <h1 class="text-4xl font-bold">urateam Pro</h1>
  <p class="mt-4 text-lg">Your autonomous engineering manager.</p>

  <section class="mt-12 rounded-lg border p-8">
    <h2 class="text-2xl font-semibold">Pro</h2>
    <p class="mt-2 text-slate-600">$X/month per organization, up to 25 active users.</p>
    <ul class="mt-6 space-y-2 list-disc list-inside text-slate-700">
      <li>Multi-repo + stage-model overrides</li>
      <li>PM Agent with conflict detection, approval workflows, Slack interface</li>
      <li>Advanced auto-merge + deep review</li>
    </ul>
    <form method="POST" action="https://billing.urateams.com/checkout" class="mt-8">
      <button class="rounded-md bg-slate-900 text-white px-5 py-3 font-semibold hover:bg-slate-800">Buy Pro</button>
    </form>
  </section>

  <p class="mt-12 text-sm text-slate-500">
    Need Enterprise? <a href="mailto:sales@urateams.com" class="underline">Contact sales</a>.
  </p>
</main></body></html>
```

- [ ] **Step 2: Commit and open PR 3**

```bash
git add pages/pricing.html
git commit -m "feat: pricing page with Buy Pro button"
git push -u origin feat/email-checkout
gh pr create --title "PR 3: Email + checkout + pricing page" --body "Completes the purchase flow. Stranger → /pricing → /checkout → Stripe → /stripe/webhook → KV + welcome email."
```

Invoke `review` skill with Sonnet subagent. Land fixes. Merge.

---

## Task 9: `invoice.paid` renewal handler

**Files:**
- Modify: `worker/src/routes/webhook.ts`
- Create: `worker/src/templates/renewal.ts`
- Test: `worker/test/invoice-paid.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// worker/test/invoice-paid.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import Stripe from "stripe";
import worker from "../src/index";
import { generateKeyPair, exportPKCS8 } from "jose";
import { writeLicense } from "../src/lib/kv";

function makeInvoicePaidEvent(customerId: string): string {
  return JSON.stringify({
    id: "evt_" + Math.random().toString(36).slice(2),
    type: "invoice.paid",
    data: { object: { customer: customerId, subscription: "sub_xyz" } },
  });
}
function signHeader(body: string): string {
  return (Stripe as any).webhooks.generateTestHeaderString({
    payload: body, secret: "whsec_test", timestamp: Math.floor(Date.now() / 1000),
  });
}

beforeEach(async () => {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  (env as any).SIGNING_KEY = await exportPKCS8(privateKey);
  (env as any).STRIPE_WEBHOOK_SECRET = "whsec_test";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
});

describe("invoice.paid", () => {
  it("no-ops when key is >30 days from expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeLicense(env.LICENSES, "cus_fresh", {
      stripeSubscriptionId: "sub_xyz", currentJwt: "stale.jwt",
      issuedAt: now - 86400, expiresAt: now + 60 * 86400, email: "a@b.com", organization: "A",
    });
    const body = makeInvoicePaidEvent("cus_fresh");
    const ctx = createExecutionContext();
    await worker.fetch(new Request("https://billing.urateams.com/stripe/webhook", {
      method: "POST", headers: { "stripe-signature": signHeader(body) }, body,
    }), env as any, ctx);
    await waitOnExecutionContext(ctx);
    const rec = await env.LICENSES.get("cus_fresh", "json") as any;
    expect(rec.currentJwt).toBe("stale.jwt"); // unchanged
  });

  it("re-mints and emails when <30 days from expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeLicense(env.LICENSES, "cus_soon", {
      stripeSubscriptionId: "sub_xyz", currentJwt: "stale.jwt",
      issuedAt: now - 86400, expiresAt: now + 10 * 86400, email: "b@c.com", organization: "B",
    });
    const body = makeInvoicePaidEvent("cus_soon");
    const ctx = createExecutionContext();
    await worker.fetch(new Request("https://billing.urateams.com/stripe/webhook", {
      method: "POST", headers: { "stripe-signature": signHeader(body) }, body,
    }), env as any, ctx);
    await waitOnExecutionContext(ctx);
    const rec = await env.LICENSES.get("cus_soon", "json") as any;
    expect(rec.currentJwt).not.toBe("stale.jwt");
    expect(rec.expiresAt).toBeGreaterThan(now + 300 * 86400);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement renewal template `worker/src/templates/renewal.ts`**

```ts
import type { RenderedEmail } from "./welcome";
export function renderRenewal(input: { email: string; organization: string; jwt: string }): RenderedEmail {
  return {
    subject: "Your urateam Pro license has been renewed",
    html: `<p>Your renewed license key is attached.</p><pre><code>${input.jwt}</code></pre>`,
    text: `Your renewed license key:\n\n${input.jwt}\n`,
    attachments: [{ filename: "urateam-license.jwt", content: btoa(input.jwt) }],
  };
}
```

Export `RenderedEmail` from `welcome.ts`.

- [ ] **Step 4: Extend `webhook.ts` to handle `invoice.paid`**

```ts
// add case in switch:
case "invoice.paid":
  await handleInvoicePaid(event, env, request);
  break;

async function handleInvoicePaid(event: Stripe.Event, env: Env, request: Request): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!customerId) return;
  const rec = await readLicense(env.LICENSES, customerId);
  if (!rec) return;

  const now = Math.floor(Date.now() / 1000);
  const daysToExpiry = (rec.expiresAt - now) / 86400;
  if (daysToExpiry > 30) {
    console.info("invoice_paid_noop_fresh_key", { customerId, daysToExpiry });
    return;
  }

  const jwt = await signLicense(env.SIGNING_KEY, { sub: customerId, tier: "pro", seats: 25 });
  const updated: LicenseRecord = {
    ...rec,
    currentJwt: jwt,
    issuedAt: now,
    expiresAt: now + 13 * 30 * 86400,
  };
  await writeLicense(env.LICENSES, customerId, updated);
  await appendAudit(env.AUDIT, customerId, {
    action: "renewed",
    ip: request.headers.get("cf-connecting-ip") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  });

  try {
    const { renderRenewal } = await import("../templates/renewal");
    const { sendEmail } = await import("../lib/email");
    const rendered = renderRenewal({ email: rec.email, organization: rec.organization, jwt });
    await sendEmail(env.RESEND_API_KEY, { to: rec.email, ...rendered });
  } catch (err) {
    console.error("renewal_email_failed", { customerId, err: String(err) });
  }
}
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/renewals
git add -A
git commit -m "feat: invoice.paid re-mints license when <30 days from expiry"
```

---

## Task 10: Scheduled cron — 14-day renewal sweep

**Files:**
- Create: `worker/src/scheduled.ts`
- Modify: `worker/src/index.ts` (wire into `scheduled` export)
- Test: `worker/test/scheduled.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// worker/test/scheduled.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { generateKeyPair, exportPKCS8 } from "jose";
import { writeLicense } from "../src/lib/kv";

beforeEach(async () => {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  (env as any).SIGNING_KEY = await exportPKCS8(privateKey);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("api.stripe.com/v1/subscriptions/")) {
      return new Response(JSON.stringify({ status: "active" }), { status: 200 });
    }
    if (String(url).includes("resend.com")) {
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }
    throw new Error("unexpected fetch: " + url);
  });
});

describe("scheduled cron", () => {
  it("re-mints keys expiring within 14 days if subscription is active", async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeLicense(env.LICENSES, "cus_soon", {
      stripeSubscriptionId: "sub_1", currentJwt: "old.jwt",
      issuedAt: now - 86400, expiresAt: now + 7 * 86400, email: "a@b.com", organization: "A",
    });
    await writeLicense(env.LICENSES, "cus_far", {
      stripeSubscriptionId: "sub_2", currentJwt: "far.jwt",
      issuedAt: now, expiresAt: now + 200 * 86400, email: "b@c.com", organization: "B",
    });

    const ctx = createExecutionContext();
    await worker.scheduled!({ scheduledTime: Date.now(), cron: "0 6 * * *" } as any, env as any, ctx);
    await waitOnExecutionContext(ctx);

    const soon = await env.LICENSES.get("cus_soon", "json") as any;
    const far = await env.LICENSES.get("cus_far", "json") as any;
    expect(soon.currentJwt).not.toBe("old.jwt"); // re-minted
    expect(far.currentJwt).toBe("far.jwt"); // untouched
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/scheduled.ts`**

```ts
import type { Env } from "./index";
import { getStripe } from "./lib/stripe";
import { signLicense } from "./lib/jwt";
import { readLicense, writeLicense, appendAudit, LicenseRecord } from "./lib/kv";
import { renderRenewal } from "./templates/renewal";
import { sendEmail } from "./lib/email";

const FOURTEEN_DAYS_SEC = 14 * 86400;

export async function runDailySweep(env: Env): Promise<void> {
  const stripe = getStripe(env);
  const now = Math.floor(Date.now() / 1000);
  let cursor: string | undefined;
  do {
    const page = await env.LICENSES.list({ cursor, limit: 1000 });
    for (const { name: customerId } of page.keys) {
      const rec = await readLicense(env.LICENSES, customerId);
      if (!rec) continue;
      if (rec.expiresAt - now > FOURTEEN_DAYS_SEC) continue;
      let sub;
      try { sub = await stripe.subscriptions.retrieve(rec.stripeSubscriptionId); }
      catch (err) { console.warn("sweep_sub_fetch_failed", { customerId, err: String(err) }); continue; }
      if (sub.status !== "active") continue;
      const jwt = await signLicense(env.SIGNING_KEY, { sub: customerId, tier: "pro", seats: 25 });
      const updated: LicenseRecord = { ...rec, currentJwt: jwt, issuedAt: now, expiresAt: now + 13 * 30 * 86400 };
      await writeLicense(env.LICENSES, customerId, updated);
      await appendAudit(env.AUDIT, customerId, { action: "renewed", ip: "cron", userAgent: "scheduled" });
      try {
        const rendered = renderRenewal({ email: rec.email, organization: rec.organization, jwt });
        await sendEmail(env.RESEND_API_KEY, { to: rec.email, ...rendered });
      } catch (err) { console.error("sweep_email_failed", { customerId, err: String(err) }); }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
import { runDailySweep } from "./scheduled";
// replace scheduled body:
async scheduled(_event, env, _ctx) { await runDailySweep(env); },
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: daily cron sweep renews keys expiring in ≤14 days"
```

---

## Task 11: `customer.subscription.deleted` lapse handler

**Files:**
- Modify: `worker/src/routes/webhook.ts`
- Create: `worker/src/templates/lapsed.ts`
- Test: `worker/test/subscription-deleted.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// worker/test/subscription-deleted.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import Stripe from "stripe";
import worker from "../src/index";
import { writeLicense } from "../src/lib/kv";

function makeEvent(customerId: string): string {
  return JSON.stringify({
    id: "evt_" + Math.random().toString(36).slice(2),
    type: "customer.subscription.deleted",
    data: { object: { customer: customerId, id: "sub_1" } },
  });
}
function sig(body: string): string {
  return (Stripe as any).webhooks.generateTestHeaderString({
    payload: body, secret: "whsec_test", timestamp: Math.floor(Date.now() / 1000),
  });
}

beforeEach(() => {
  (env as any).STRIPE_WEBHOOK_SECRET = "whsec_test";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
});

describe("customer.subscription.deleted", () => {
  it("sends lapsed email but keeps JWT intact", async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeLicense(env.LICENSES, "cus_gone", {
      stripeSubscriptionId: "sub_1", currentJwt: "valid.jwt",
      issuedAt: now, expiresAt: now + 300 * 86400, email: "g@h.com", organization: "Gone Co",
    });
    const body = makeEvent("cus_gone");
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://billing.urateams.com/stripe/webhook", {
      method: "POST", headers: { "stripe-signature": sig(body) }, body,
    }), env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const rec = await env.LICENSES.get("cus_gone", "json") as any;
    expect(rec.currentJwt).toBe("valid.jwt"); // not invalidated
    const audit = await env.AUDIT.list({ prefix: "cus_gone:" });
    expect(audit.keys.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement lapsed template**

```ts
// worker/src/templates/lapsed.ts
import type { RenderedEmail } from "./welcome";
export function renderLapsed(input: { email: string; expiresAt: number }): RenderedEmail {
  const date = new Date(input.expiresAt * 1000).toISOString().slice(0, 10);
  return {
    subject: "Your urateam Pro subscription has ended",
    html: `<p>Your subscription has been cancelled.</p>
<p>Your current license key will keep working until <strong>${date}</strong>.</p>
<p><a href="https://billing.urateams.com/recover">Resubscribe or update payment</a></p>`,
    text: `Your subscription has been cancelled.\nYour key works until ${date}.\nResubscribe: https://billing.urateams.com/recover\n`,
    attachments: [],
  };
}
```

- [ ] **Step 4: Add case to webhook handler**

```ts
case "customer.subscription.deleted":
  await handleSubscriptionDeleted(event, env, request);
  break;

async function handleSubscriptionDeleted(event: Stripe.Event, env: Env, request: Request): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (!customerId) return;
  const rec = await readLicense(env.LICENSES, customerId);
  if (!rec) return;
  await appendAudit(env.AUDIT, customerId, {
    action: "lapsed",
    ip: request.headers.get("cf-connecting-ip") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  });
  try {
    const { renderLapsed } = await import("../templates/lapsed");
    const { sendEmail } = await import("../lib/email");
    const rendered = renderLapsed({ email: rec.email, expiresAt: rec.expiresAt });
    await sendEmail(env.RESEND_API_KEY, { to: rec.email, ...rendered });
  } catch (err) {
    console.error("lapsed_email_failed", { customerId, err: String(err) });
  }
}
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit and open PR 4**

```bash
git add -A
git commit -m "feat: customer.subscription.deleted sends lapsed email"
git push -u origin feat/renewals
gh pr create --title "PR 4: Renewals + lapse" --body "invoice.paid re-mint (<30d), daily cron sweep (≤14d), customer.subscription.deleted lapsed email."
```

Invoke `review` skill. Land fixes. Merge.

---

## Task 12: Magic-link lib (HMAC token mint + verify, single-use)

**Files:**
- Create: `worker/src/lib/magic-link.ts`
- Test: `worker/test/magic-link.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// worker/test/magic-link.test.ts
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { mintMagicLink, consumeMagicLink, peekMagicLink } from "../src/lib/magic-link";

const SECRET = "a".repeat(64); // 32 bytes hex

describe("magic-link", () => {
  it("mints and consumes a token", async () => {
    const { token } = await mintMagicLink(env.MAGIC_LINKS, SECRET, "cus_1");
    const consumed = await consumeMagicLink(env.MAGIC_LINKS, SECRET, token);
    expect(consumed?.customerId).toBe("cus_1");
  });

  it("rejects a consumed token on second use", async () => {
    const { token } = await mintMagicLink(env.MAGIC_LINKS, SECRET, "cus_1");
    await consumeMagicLink(env.MAGIC_LINKS, SECRET, token);
    expect(await consumeMagicLink(env.MAGIC_LINKS, SECRET, token)).toBeNull();
  });

  it("rejects a forged token (wrong HMAC)", async () => {
    const fake = "ff".repeat(32) + ".deadbeef";
    expect(await consumeMagicLink(env.MAGIC_LINKS, SECRET, fake)).toBeNull();
  });

  it("peek returns customerId without consuming", async () => {
    const { token } = await mintMagicLink(env.MAGIC_LINKS, SECRET, "cus_1");
    expect(await peekMagicLink(env.MAGIC_LINKS, SECRET, token)).toBe("cus_1");
    expect(await peekMagicLink(env.MAGIC_LINKS, SECRET, token)).toBe("cus_1"); // still there
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/lib/magic-link.ts`**

```ts
const TTL_SECONDS = 15 * 60;

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secretHex: string, data: string): Promise<string> {
  const keyBytes = new Uint8Array(secretHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return hexEncode(new Uint8Array(sig));
}

export async function mintMagicLink(
  kv: KVNamespace,
  hmacSecretHex: string,
  customerId: string,
): Promise<{ token: string }> {
  const rand = crypto.getRandomValues(new Uint8Array(32));
  // Pass the Uint8Array directly. DO NOT use rand.buffer: in some runtimes the
  // backing ArrayBuffer can be larger than the view's byteLength, which would
  // silently leak unrequested bytes into the token and break HMAC verification.
  const raw = hexEncode(rand);
  const mac = await hmacHex(hmacSecretHex, raw);
  const token = `${raw}.${mac.slice(0, 16)}`;
  await kv.put(raw, JSON.stringify({ customerId }), { expirationTtl: TTL_SECONDS });
  return { token };
}

async function parseAndVerify(secretHex: string, token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [raw, sigFromToken] = parts;
  if (!/^[0-9a-f]{64}$/.test(raw)) return null;
  const expected = (await hmacHex(secretHex, raw)).slice(0, 16);
  // constant-time-ish string compare
  if (expected.length !== sigFromToken.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigFromToken.charCodeAt(i);
  if (diff !== 0) return null;
  return raw;
}

export async function peekMagicLink(
  kv: KVNamespace,
  secretHex: string,
  token: string,
): Promise<string | null> {
  const raw = await parseAndVerify(secretHex, token);
  if (!raw) return null;
  const entry = await kv.get<{ customerId: string }>(raw, "json");
  return entry?.customerId ?? null;
}

export async function consumeMagicLink(
  kv: KVNamespace,
  secretHex: string,
  token: string,
): Promise<{ customerId: string } | null> {
  const raw = await parseAndVerify(secretHex, token);
  if (!raw) return null;
  const entry = await kv.get<{ customerId: string }>(raw, "json");
  if (!entry) return null;
  await kv.delete(raw);
  return entry;
}
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/recovery-portal
git add -A
git commit -m "feat: magic-link mint/peek/consume with HMAC + 15-min TTL"
```

---

## Task 13: `POST /recover` route

**Files:**
- Create: `worker/src/routes/recover.ts`
- Create: `worker/src/templates/recover.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/recover-post.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// worker/test/recover-post.test.ts
import { describe, expect, it, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

describe("POST /recover", () => {
  it("sends a magic-link email when email matches a Stripe customer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("api.stripe.com/v1/customers")) {
        return new Response(JSON.stringify({ data: [{ id: "cus_found" }] }), { status: 200 });
      }
      if (String(url).includes("resend.com")) {
        return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/recover", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "email=a%40b.com",
      }), env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const resendCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("resend.com"));
    expect(resendCall).toBeTruthy();
  });

  it("returns 200 with no email send when no match (prevents enumeration)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("api.stripe.com/v1/customers")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/recover", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "email=nobody%40x.com",
      }), env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const resendCall = fetchSpy.mock.calls.find(c => String(c[0]).includes("resend.com"));
    expect(resendCall).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement recover email template**

```ts
// worker/src/templates/recover.ts
import type { RenderedEmail } from "./welcome";
export function renderRecover(input: { link: string }): RenderedEmail {
  return {
    subject: "Your urateam license key",
    html: `<p>Click the link below to retrieve your license key. Link expires in 15 minutes.</p>
<p><a href="${input.link}">${input.link}</a></p>`,
    text: `Retrieve your license key (expires in 15 min):\n${input.link}\n`,
    attachments: [],
  };
}
```

- [ ] **Step 4: Implement `worker/src/routes/recover.ts` (POST only for now; GET in Task 14)**

```ts
import type { Env } from "../index";
import { getStripe } from "../lib/stripe";
import { mintMagicLink } from "../lib/magic-link";
import { sendEmail } from "../lib/email";
import { renderRecover } from "../templates/recover";

export async function handleRecoverPost(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!email) return new Response("email required", { status: 400 });

  const stripe = getStripe(env);
  let customerId: string | null = null;
  try {
    const list = await stripe.customers.list({ email, limit: 1 });
    customerId = list.data[0]?.id ?? null;
  } catch (err) { console.warn("recover_stripe_lookup_failed", { err: String(err) }); }

  if (customerId) {
    const { token } = await mintMagicLink(env.MAGIC_LINKS, env.MAGIC_LINK_HMAC_SECRET, customerId);
    const link = `https://billing.urateams.com/recover/${token}`;
    try {
      const rendered = renderRecover({ link });
      await sendEmail(env.RESEND_API_KEY, { to: email, ...rendered });
    } catch (err) { console.error("recover_email_failed", { err: String(err) }); }
  }

  // Always 200 to prevent email enumeration.
  return new Response(
    `<!doctype html><html><body><p>If that email matches an account, we've sent a recovery link.</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
}
```

- [ ] **Step 5: Wire in `src/index.ts`**

```ts
if (url.pathname === "/recover" && request.method === "POST") {
  return await handleRecoverPost(request, env);
}
```

- [ ] **Step 6: Run — expect pass**

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: POST /recover sends magic-link email (no enumeration leak)"
```

---

## Task 14: `GET /recover/:token` — render page with JWT + pre-generated portal URL

**Files:**
- Modify: `worker/src/routes/recover.ts`
- Create: `worker/src/templates/recover-page.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/recover-get.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// worker/test/recover-get.test.ts
import { describe, expect, it, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { writeLicense } from "../src/lib/kv";
import { mintMagicLink } from "../src/lib/magic-link";

describe("GET /recover/:token", () => {
  it("renders JWT + portal URL, deletes magic link (single use)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeLicense(env.LICENSES, "cus_r", {
      stripeSubscriptionId: "sub_r", currentJwt: "user.jwt.here",
      issuedAt: now, expiresAt: now + 365 * 86400, email: "r@r.com", organization: "R",
    });
    const { token } = await mintMagicLink(env.MAGIC_LINKS, (env as any).MAGIC_LINK_HMAC_SECRET, "cus_r");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("api.stripe.com/v1/billing_portal/sessions")) {
        return new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session/sess_1" }), { status: 200 });
      }
      throw new Error("unexpected fetch: " + url);
    });

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://billing.urateams.com/recover/${token}`), env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user.jwt.here");
    expect(html).toContain("billing.stripe.com/p/session/sess_1");

    // Single-use: second visit → 410
    const ctx2 = createExecutionContext();
    const res2 = await worker.fetch(
      new Request(`https://billing.urateams.com/recover/${token}`), env as any, ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(410);
  });

  it("returns 410 on unknown/tampered token", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://billing.urateams.com/recover/ff.ff`), env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement recover success page template**

```ts
// worker/src/templates/recover-page.ts
export function renderRecoverPage(input: { jwt: string; portalUrl: string; organization: string }): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Your urateam license</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-white text-slate-900"><main class="max-w-2xl mx-auto p-8">
<h1 class="text-3xl font-bold">Your urateam Pro license key</h1>
<p class="mt-4">Copy the key below or download the file:</p>
<pre class="mt-4 bg-slate-100 p-4 rounded overflow-x-auto text-xs">${input.jwt}</pre>
<p class="mt-4">
  <a class="underline" href="data:application/jwt;charset=utf-8,${encodeURIComponent(input.jwt)}" download="urateam-license.jwt">Download .jwt file</a>
</p>
<p class="mt-8">
  <a class="rounded-md bg-slate-900 text-white px-5 py-3 font-semibold" href="${input.portalUrl}">Manage billing</a>
</p>
</main></body></html>`;
}
```

- [ ] **Step 4: Implement `handleRecoverGet` in `worker/src/routes/recover.ts`**

```ts
import type { Env } from "../index";
import { getStripe } from "../lib/stripe";
import { consumeMagicLink } from "../lib/magic-link";
import { readLicense, appendAudit } from "../lib/kv";
import { renderRecoverPage } from "../templates/recover-page";

export async function handleRecoverGet(request: Request, env: Env, token: string): Promise<Response> {
  const consumed = await consumeMagicLink(env.MAGIC_LINKS, env.MAGIC_LINK_HMAC_SECRET, token);
  if (!consumed) return new Response("link expired or already used", { status: 410 });
  const rec = await readLicense(env.LICENSES, consumed.customerId);
  if (!rec) return new Response("license not found", { status: 410 });

  const stripe = getStripe(env);
  const portal = await stripe.billingPortal.sessions.create({
    customer: consumed.customerId,
    return_url: "https://urateams.com/thanks",
  });

  await appendAudit(env.AUDIT, consumed.customerId, {
    action: "recovered",
    ip: request.headers.get("cf-connecting-ip") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  });
  await appendAudit(env.AUDIT, consumed.customerId, {
    action: "portal-opened",
    ip: request.headers.get("cf-connecting-ip") ?? "",
    userAgent: request.headers.get("user-agent") ?? "",
  });

  const html = renderRecoverPage({
    jwt: rec.currentJwt,
    portalUrl: portal.url,
    organization: rec.organization,
  });
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}
```

- [ ] **Step 5: Wire in `src/index.ts`**

```ts
const recoverMatch = url.pathname.match(/^\/recover\/([^/]+)$/);
if (recoverMatch && request.method === "GET") {
  return await handleRecoverGet(request, env, recoverMatch[1]);
}
```

- [ ] **Step 6: Run — expect pass**

- [ ] **Step 7: Commit and open PR 5**

```bash
git add -A
git commit -m "feat: GET /recover/:token renders JWT + Stripe Portal link"
git push -u origin feat/recovery-portal
gh pr create --title "PR 5: Recovery + portal" --body "Magic-link recovery flow with pre-generated Stripe Customer Portal URL embedded on success page. Single-use tokens, 15-min TTL, no enumeration leak."
```

Invoke `review` skill. Land fixes. Merge.

---

## Task 15: `/admin/audit` route (HTTP Basic Auth, read-only)

**Files:**
- Create: `worker/src/routes/admin.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/admin.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// worker/test/admin.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { appendAudit } from "../src/lib/kv";

// Precomputed bcrypt: admin:hunter2 → see note below
const BASIC_CONFIG = "admin:$2a$10$FAKE_HASH"; // replaced with real bcrypt hash in test setup

beforeEach(() => {
  // For testing, use a plaintext-equality mode keyed by a magic prefix "plain:"
  (env as any).ADMIN_BASIC_AUTH = "plain:admin:hunter2";
});

describe("GET /admin/audit", () => {
  it("401 without auth", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/admin/audit?customerId=cus_1"), env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/basic/i);
  });

  it("200 with correct auth, returns audit entries", async () => {
    await appendAudit(env.AUDIT, "cus_1", { action: "issued", ip: "1.1.1.1", userAgent: "ua" });
    const creds = btoa("admin:hunter2");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/admin/audit?customerId=cus_1", {
        headers: { authorization: `Basic ${creds}` },
      }), env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.entries.length).toBeGreaterThan(0);
    expect(json.entries[0].action).toBe("issued");
  });

  it("401 with wrong password", async () => {
    const creds = btoa("admin:wrong");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://billing.urateams.com/admin/audit?customerId=cus_1", {
        headers: { authorization: `Basic ${creds}` },
      }), env as any, ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement `worker/src/routes/admin.ts`**

```ts
import type { Env } from "../index";

export async function handleAdminAudit(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Basic ")) {
    return new Response("auth required", { status: 401, headers: { "www-authenticate": 'Basic realm="admin"' } });
  }
  const decoded = atob(auth.slice(6));
  if (!checkCredentials(decoded, env.ADMIN_BASIC_AUTH)) {
    return new Response("forbidden", { status: 401 });
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");
  if (!customerId) return new Response("customerId required", { status: 400 });

  const list = await env.AUDIT.list({ prefix: `${customerId}:` });
  const entries = await Promise.all(
    list.keys.map(async k => ({ key: k.name, ...(await env.AUDIT.get<any>(k.name, "json")) })),
  );
  return new Response(JSON.stringify({ customerId, entries }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}

function checkCredentials(provided: string, configured: string): boolean {
  // MVP: only "plain:<user>:<password>" is supported. Workers lack native bcrypt;
  // upgrade to argon2 via WebCrypto is tracked as a follow-up (see docs/OPERATIONS.md).
  if (!configured.startsWith("plain:")) {
    throw new Error("ADMIN_BASIC_AUTH must start with 'plain:' in MVP — see docs/OPERATIONS.md");
  }
  // Constant-time string compare to avoid timing attacks.
  const expected = configured.slice(6);
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
```

Note on Basic Auth: Workers do not have a native bcrypt. For the MVP, ship with the `plain:` prefix path only (configure `ADMIN_BASIC_AUTH = "plain:admin:STRONG_RANDOM"` as a Workers Secret — use a long random password, `openssl rand -base64 32`). Upgrade to argon2 or scrypt via WebCrypto in a follow-up issue — tracked in `docs/OPERATIONS.md`. The admin route throws at request time (500) if the secret is mis-configured without `plain:`, which fails fast rather than silently accepting requests.

- [ ] **Step 4: Wire in `src/index.ts`**

```ts
if (url.pathname === "/admin/audit" && request.method === "GET") {
  return await handleAdminAudit(request, env);
}
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git checkout -b feat/admin-docs
git add -A
git commit -m "feat: /admin/audit route with Basic Auth (plain: for MVP)"
```

---

## Task 16: Rate limiting + operations docs

**Files:**
- Create: `docs/DEVELOPING.md`
- Create: `docs/OPERATIONS.md`
- Create: `docs/rotation.md`

- [ ] **Step 1: Configure Cloudflare rate limit rule for `/recover`**

In the Cloudflare dashboard → Security → WAF → Rate limiting rules:
- Rule name: `recover-rate-limit`
- If URI path equals `/recover` and HTTP method = POST
- Characteristics: IP
- Requests: 5 per 1 hour
- Action: Block

(This is an operational config, not code. Document the rule in `OPERATIONS.md`.)

- [ ] **Step 2: Write `docs/DEVELOPING.md`**

```markdown
# Developing

## Local setup
1. `pnpm install` (in `worker/`)
2. Generate a test signing keypair: `pnpm tsx ../scripts/gen-signing-key.ts`
3. Copy the output into `worker/.dev.vars` (see `.dev.vars.example`)
4. `pnpm dev` — starts Miniflare on `localhost:8787`

## Testing with Stripe CLI
Install the Stripe CLI, then:
```
stripe login
stripe listen --forward-to localhost:8787/stripe/webhook
stripe trigger checkout.session.completed
stripe trigger invoice.paid
stripe trigger customer.subscription.deleted
```
The `stripe listen` command prints a webhook secret — paste it into `.dev.vars` as `STRIPE_WEBHOOK_SECRET`.

## Running tests
- `pnpm test` — all tests
- `pnpm test jwt` — filter to a pattern
- `pnpm test --watch`
```

- [ ] **Step 3: Write `docs/OPERATIONS.md`**

```markdown
# Operations

## Deploy
`main` auto-deploys via `.github/workflows/deploy.yml`. Smoke test runs `GET /health`.

## Secrets (Workers Secrets)
- `SIGNING_KEY` — Ed25519 private key (PKCS8 PEM). Generated once; rotate per `rotation.md`.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — from Stripe dashboard.
- `RESEND_API_KEY` — from Resend dashboard.
- `MAGIC_LINK_HMAC_SECRET` — 64 hex chars. Generate: `openssl rand -hex 32`.
- `ADMIN_BASIC_AUTH` — `plain:<user>:<password>` for MVP (see Task 15 note).
- `STRIPE_PRO_PRICE_ID` — set in `wrangler.toml` `[vars]`; update via PR.

## Alerts
- Cloudflare → Workers → urateam-licensing → Alerts: 5xx rate > 1%.
- Stripe dashboard → Developers → Webhooks → Set email on delivery failure.
- Resend dashboard → Settings → Alerts: bounce rate > 5%.

## Support playbook
- Customer lost their key → direct to `billing.urateams.com/recover`.
- Customer emails asking for manual help → `GET /admin/audit?customerId=cus_xxx` to see their history; refer to KV `LICENSES` for current key via `wrangler kv:key get --binding=LICENSES cus_xxx`.

## Known MVP limitations
- `ADMIN_BASIC_AUTH` uses `plain:` mode. Upgrade to argon2 via WebCrypto — tracked in follow-up issue.
- Renewal-email retry queue is synchronous; if Resend is down, cron handles recovery on next day.
```

- [ ] **Step 4: Write `docs/rotation.md`**

```markdown
# Secret rotation procedures

## Signing key (Ed25519)
1. Run `pnpm tsx scripts/gen-signing-key.ts` to generate new keypair.
2. Prepare a PR in the **urateam** repo that adds the new public key alongside the existing one in `packages/core/src/license.ts`, changing `verifyLicense` to try both keys. Merge + release.
3. After the urateam release is live in customer environments (give ~1 week), update `SIGNING_KEY` in Workers Secrets to the new private key:
   `pnpm exec wrangler secret put SIGNING_KEY` (paste new private PEM).
4. New JWTs mint with new key; old JWTs still verify against old public key until they expire (13 months).
5. After 13 months, open a PR in urateam removing the old public key.

## Stripe webhook secret
1. Stripe dashboard → Developers → Webhooks → endpoint → Roll secret.
2. Stripe supports a 24-hour window where both old and new secrets validate.
3. `pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET` with the new value.
4. Deploy; verify with `stripe trigger invoice.paid`.

## Resend API key
1. Resend dashboard → API keys → Create new; revoke old.
2. `pnpm exec wrangler secret put RESEND_API_KEY`.
3. Deploy.

## Magic-link HMAC secret
Breaks any in-flight recovery links immediately. Acceptable — they're 15-min TTL.
1. `openssl rand -hex 32` → new value.
2. `pnpm exec wrangler secret put MAGIC_LINK_HMAC_SECRET`.
3. Deploy.

## Admin basic auth
1. Generate new strong password.
2. `pnpm exec wrangler secret put ADMIN_BASIC_AUTH` with `plain:admin:NEWPASSWORD`.
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: DEVELOPING, OPERATIONS, rotation playbooks"
```

---

## Task 17: First live $1 purchase smoke test

**Files:**
- No code changes; operational checklist.

- [ ] **Step 1: In Stripe dashboard (live mode), create a one-off `$1 urateam-smoke` product**

Stripe → Products → Add product → `urateam-smoke`, recurring, $1/month. Copy the price id.

- [ ] **Step 2: Update `STRIPE_PRO_PRICE_ID` in `wrangler.toml` `[vars]` to the smoke price id, deploy**

- [ ] **Step 3: From a clean browser (not your admin account), go to `urateams.com/pricing`, click Buy Pro, complete Stripe checkout with a real card**

- [ ] **Step 4: Verify within 60 seconds**

- Welcome email arrived at the test email address.
- JWT in the email loads cleanly: `echo $JWT | jose-cli verify --alg EdDSA -k <path to public key>` (or use a small node script).
- `wrangler kv:key get --binding=LICENSES <your customer id>` returns the expected record.
- `curl --user plain-auth https://billing.urateams.com/admin/audit?customerId=cus_xxx` returns the `issued` entry.

- [ ] **Step 5: In Stripe dashboard, cancel the subscription, verify lapsed email arrives**

- [ ] **Step 6: Go to `billing.urateams.com/recover`, request your email, verify the link works and the portal URL opens Stripe Portal successfully**

- [ ] **Step 7: Revert `STRIPE_PRO_PRICE_ID` to the real Pro price, archive the `urateam-smoke` product in Stripe, deploy**

- [ ] **Step 8: Commit and open PR 6**

```bash
git add -A
git commit -m "chore: first live smoke test confirmed end-to-end"
git push -u origin feat/admin-docs
gh pr create --title "PR 6: Admin + docs + smoke test" --body "/admin/audit route, OPERATIONS/DEVELOPING/rotation docs, first real-world purchase verified."
```

Invoke `review` skill. Land fixes. Merge. **Phase 2 complete.**

---

## Post-implementation follow-ups (tracked as GitHub issues on urateam-licensing)

- Upgrade `/admin/audit` from `plain:` to argon2 via WebCrypto
- Add welcome/renewal-email retry queue via Cloudflare Queues
- Add annual pricing (second Stripe price id, cadence hint in metadata)
- Add React Email templates (replace hand-rolled HTML)
- Axiom/Logtail log forwarding
- Add tests for KV list pagination in the cron sweep (>1000 customers)
- Cross-repo PR on urateam itself: multi-key verify in `@urateam/core/license.ts` before first signing-key rotation
- **Replace Tailwind CDN (`https://cdn.tailwindcss.com`) with a local build** for `pages/pricing.html` and the recover success page. The CDN script is intended for dev/prototyping, requires a permissive script-src CSP, and introduces a third-party runtime dependency. Fine for v1 launch; not for scale.
- **Bump Stripe SDK `apiVersion`** (currently pinned to `"2024-06-20"`) to the newest GA version before Task 17 live smoke test and again whenever the SDK rev ships a deprecation notice.
