# License Infrastructure (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder `checkLicense()` (any non-empty `URATEAM_LICENSE_KEY` grants Pro) with offline Ed25519-signed JWT validation, rename the tier enum from `free|pro|team|enterprise` to `oss|pro|enterprise`, and ship a hidden `ura license issue` admin CLI for generating Enterprise license keys manually.

**Architecture:** All license validation happens offline against an embedded Ed25519 public key. No phone-home, no licensing service. The corresponding private key is held by the operator and used by `ura license issue` to sign new keys; in production it lives in a Stripe webhook handler (out of scope for this phase). Verification uses Node 22's built-in `crypto.subtle` — no `jose` / `jsonwebtoken` dependency.

**Tech Stack:** TypeScript, Node 22 built-in `node:crypto` (Ed25519), Vitest, Commander.

**Spec:** `docs/superpowers/specs/2026-04-13-enterprise-tier-design.md` § 5.

---

## File map

**Created:**
- `packages/core/src/license-public-key.ts` — exports the embedded Ed25519 public key as a base64url-encoded raw 32-byte string.
- `packages/cli/src/commands/license.ts` — the hidden `ura license issue` command.
- `packages/cli/src/__tests__/license-command.test.ts` — integration test for the issue command.
- `scripts/generate-license-keypair.ts` — operator helper that prints a fresh Ed25519 keypair (run once, manually).

**Rewritten:**
- `packages/core/src/license.ts` — replaces placeholder with JWT validation; tier enum becomes `oss | pro | enterprise`.
- `packages/core/src/__tests__/license.test.ts` — full coverage of the new validation paths.

**Modified:**
- `packages/cli/src/index.ts` — register the (hidden) `license` subcommand.
- `CHANGELOG.md` — Unreleased section gets a migration note for the tier rename + license format change.

**Verified (no edit expected, but each file references `tier` or the license API and must continue to work):**
- `packages/core/src/index.ts`
- `packages/core/src/server.ts`
- `packages/core/src/pipeline/runner.ts`
- `packages/core/src/pm/scheduler.ts`

---

## Task 1: Generate the signing keypair (operator helper)

**Files:**
- Create: `scripts/generate-license-keypair.ts`

The operator runs this once to produce a real keypair. The private key is saved to a password manager / Vault and used by `ura license issue`; the public key is pasted into `packages/core/src/license-public-key.ts` (Task 2).

- [ ] **Step 1: Create `scripts/generate-license-keypair.ts`**

```ts
#!/usr/bin/env tsx
/**
 * Generate a fresh Ed25519 keypair for license signing.
 *
 * Usage:
 *   pnpm tsx scripts/generate-license-keypair.ts
 *
 * Prints the public key (paste into packages/core/src/license-public-key.ts)
 * and the private key (store securely — DO NOT commit). The private key is
 * needed by `ura license issue` and the future Stripe webhook handler.
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const publicRaw = publicKey.export({ format: "der", type: "spki" });
const privateRaw = privateKey.export({ format: "der", type: "pkcs8" });

const publicB64 = Buffer.from(publicRaw).toString("base64");
const privateB64 = Buffer.from(privateRaw).toString("base64");

console.log("# Public key (paste into packages/core/src/license-public-key.ts)");
console.log(`URATEAM_LICENSE_PUBLIC_KEY_DER_B64="${publicB64}"`);
console.log("");
console.log("# Private key (STORE SECURELY — operator-only, never commit)");
console.log(`URATEAM_LICENSE_SIGNING_KEY_DER_B64="${privateB64}"`);
```

- [ ] **Step 2: Run it once and capture both keys**

Run: `pnpm tsx scripts/generate-license-keypair.ts`
Expected: prints two `_B64=...` lines. Save both to a scratch file outside the repo for use in later tasks.

- [ ] **Step 3: Commit the script (without keys)**

```bash
git add scripts/generate-license-keypair.ts
git commit -m "feat(license): add operator helper to generate Ed25519 signing keypair"
```

---

## Task 2: Embed the public key

**Files:**
- Create: `packages/core/src/license-public-key.ts`

A separate file so the public key can be rotated cleanly in a future PR without touching `license.ts`.

- [ ] **Step 1: Create `packages/core/src/license-public-key.ts`**

Replace `<PASTE_BASE64_PUBLIC_KEY_FROM_TASK_1>` with the value captured in Task 1.

```ts
/**
 * Embedded Ed25519 public key for verifying urateam license JWTs.
 *
 * Format: SubjectPublicKeyInfo (SPKI) DER, base64-encoded.
 *
 * The corresponding private key is held by the operator and never enters
 * the repository. To rotate the key:
 *   1. Run `pnpm tsx scripts/generate-license-keypair.ts`
 *   2. Replace this constant with the new public key
 *   3. Re-issue all outstanding licenses with the new private key
 *   4. Cut a urateam release; old licenses fail validation after upgrade
 */
export const LICENSE_PUBLIC_KEY_DER_B64 =
  "<PASTE_BASE64_PUBLIC_KEY_FROM_TASK_1>";
```

- [ ] **Step 2: Verify the key parses with Node crypto**

Run:
```bash
node --input-type=module -e "
  import { createPublicKey } from 'node:crypto';
  import { LICENSE_PUBLIC_KEY_DER_B64 } from './packages/core/src/license-public-key.ts';
  const k = createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY_DER_B64, 'base64'), format: 'der', type: 'spki' });
  console.log('asymmetricKeyType:', k.asymmetricKeyType);
"
```
(If the `.ts` import doesn't work directly, copy the constant inline for the smoke test.)
Expected: prints `asymmetricKeyType: ed25519`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/license-public-key.ts
git commit -m "feat(license): embed Ed25519 public key for license verification"
```

---

## Task 3: Rewrite `license.ts` — types and feature sets (OSS path only)

**Files:**
- Modify: `packages/core/src/license.ts` (full rewrite)
- Modify: `packages/core/src/__tests__/license.test.ts` (full rewrite)

This task lays down the new types, the per-tier feature map, and the `oss` (no env var) path. JWT validation is added in Task 4 — keeping them separate makes the diff reviewable.

- [ ] **Step 1: Write the failing test for the OSS path**

Replace the entire content of `packages/core/src/__tests__/license.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkLicense,
  isFeatureLicensed,
  _resetLicenseCache,
} from "../license.js";

describe("checkLicense — OSS path", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns oss tier when URATEAM_LICENSE_KEY is unset", () => {
    const status = checkLicense();
    expect(status.licensed).toBe(false);
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBeUndefined();
    expect(status.features.size).toBeGreaterThan(0);
  });

  it("caches the result for the process lifetime", () => {
    const first = checkLicense();
    process.env.URATEAM_LICENSE_KEY = "anything";
    const second = checkLicense();
    expect(second).toBe(first); // same object reference
  });
});

describe("isFeatureLicensed — OSS path", () => {
  beforeEach(() => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;
  });

  it("returns false for commercial features without a key", () => {
    for (const feat of [
      "slack-interface",
      "deep-review",
      "conflict-detection",
      "multi-repo",
      "stage-models",
      "advanced-automerge",
      "approval-workflows",
    ]) {
      expect(isFeatureLicensed(feat)).toBe(false);
    }
  });

  it("returns true for non-commercial / unknown features", () => {
    expect(isFeatureLicensed("pipeline-runner")).toBe(true);
    expect(isFeatureLicensed("basic-pm")).toBe(true);
    expect(isFeatureLicensed("unknown-feature")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/license.test.ts`
Expected: FAIL — `tier` is `"free"` not `"oss"`, `features` does not exist on `LicenseStatus`.

- [ ] **Step 3: Replace `packages/core/src/license.ts` with the new types + OSS path**

```ts
import { createLogger } from "./logger.js";

const log = createLogger({ component: "license" });

export type Tier = "oss" | "pro" | "enterprise";

export interface LicenseStatus {
  licensed: boolean;
  tier: Tier;
  customerId?: string;
  expiresAt?: Date;
  seats?: number | null;
  features: Set<string>;
  invalidReason?: "missing" | "expired" | "bad-signature" | "wrong-issuer" | "malformed";
}

/**
 * Features each tier unlocks. Higher tiers inherit lower-tier features.
 * Source of truth: docs/superpowers/specs/2026-04-13-enterprise-tier-design.md § 3.
 */
const PRO_FEATURES = [
  "slack-interface",
  "conflict-detection",
  "deep-review",
  "approval-workflows",
  "multi-repo",
  "stage-models",
  "advanced-automerge",
];

const ENTERPRISE_FEATURES = [
  ...PRO_FEATURES,
  "sso",
  "audit-log",
  "spend-caps",
  "rbac",
  "cost-dashboard",
  "org-policy",
  "pm-agent-governance",
];

const FEATURES_BY_TIER: Record<Tier, ReadonlySet<string>> = {
  oss: new Set(),
  pro: new Set(PRO_FEATURES),
  enterprise: new Set(ENTERPRISE_FEATURES),
};

/**
 * The complete set of features that are commercially gated. A feature
 * not in this set is always available regardless of license status.
 */
const ALL_COMMERCIAL_FEATURES = new Set<string>(ENTERPRISE_FEATURES);

let cachedStatus: LicenseStatus | null = null;

function ossStatus(invalidReason?: LicenseStatus["invalidReason"]): LicenseStatus {
  return {
    licensed: false,
    tier: "oss",
    features: new Set(FEATURES_BY_TIER.oss),
    invalidReason,
  };
}

/**
 * Check the license status from URATEAM_LICENSE_KEY env var.
 * Result is cached for the lifetime of the process.
 *
 * JWT validation is added in Task 4 of the license-infrastructure-phase-0
 * plan; for now, presence of the env var is ignored on the OSS path.
 */
export function checkLicense(): LicenseStatus {
  if (cachedStatus) return cachedStatus;

  const key = process.env.URATEAM_LICENSE_KEY;
  if (!key) {
    cachedStatus = ossStatus();
    log.info({ tier: "oss" }, "no license key set — running in OSS mode");
    return cachedStatus;
  }

  // Placeholder for Task 4: real JWT validation lives here.
  cachedStatus = ossStatus("malformed");
  return cachedStatus;
}

/**
 * Check if a specific feature is available under the current license.
 * Returns true for non-commercial features regardless of license status.
 */
export function isFeatureLicensed(feature: string): boolean {
  if (!ALL_COMMERCIAL_FEATURES.has(feature)) return true;
  return checkLicense().features.has(feature);
}

/** Reset cached status (for tests). */
export function _resetLicenseCache(): void {
  cachedStatus = null;
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd packages/core && npx vitest run src/__tests__/license.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Build the package to catch type errors elsewhere**

Run: `pnpm --filter @urateam/core build`
Expected: clean build. If any consumer (`server.ts`, `runner.ts`, `pm/scheduler.ts`) references the removed `key` field on `LicenseStatus`, the type checker will flag it now.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/license.ts packages/core/src/__tests__/license.test.ts
git commit -m "refactor(license): rewrite tier model — oss/pro/enterprise + per-tier feature sets"
```

---

## Task 4: Add JWT verification (Ed25519, no dependencies)

**Files:**
- Modify: `packages/core/src/license.ts`
- Modify: `packages/core/src/__tests__/license.test.ts`

Adds the `verifyJwt()` helper and wires `checkLicense()` to use it. Hand-rolled JWT parsing + Node's `crypto.verify` — no `jose` or `jsonwebtoken` dependency.

- [ ] **Step 1: Add failing tests for JWT validation paths**

Append to `packages/core/src/__tests__/license.test.ts`:

```ts
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";

// --- Test helpers: locally generated keypair, used to sign sample JWTs ---
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(privateKey: ReturnType<typeof createPrivateKey>, payload: object): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

describe("checkLicense — JWT validation", () => {
  let publicKeyB64: string;
  let privateKey: ReturnType<typeof createPrivateKey>;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    _resetLicenseCache();
    delete process.env.URATEAM_LICENSE_KEY;

    const { publicKey, privateKey: priv } = generateKeyPairSync("ed25519");
    publicKeyB64 = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64");
    privateKey = priv;

    // Override the embedded public key for the duration of this test by
    // monkey-patching the module export. The license module imports it at
    // the top level, so we need to override it before the next checkLicense().
    const mod = await import("../license-public-key.js");
    originalPublicKey = (mod as { LICENSE_PUBLIC_KEY_DER_B64: string }).LICENSE_PUBLIC_KEY_DER_B64;
    Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
      value: publicKeyB64,
      writable: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    if (originalPublicKey !== undefined) {
      const mod = await import("../license-public-key.js");
      Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
        value: originalPublicKey,
        writable: true,
        configurable: true,
      });
    }
  });

  const now = () => Math.floor(Date.now() / 1000);

  it("accepts a valid pro JWT", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_test",
      tier: "pro",
      seats: 25,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.tier).toBe("pro");
    expect(status.customerId).toBe("cust_test");
    expect(status.seats).toBe(25);
    expect(status.features.has("slack-interface")).toBe(true);
    expect(status.features.has("sso")).toBe(false);
  });

  it("accepts a valid enterprise JWT and unlocks enterprise features", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_acme",
      tier: "enterprise",
      seats: null,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.tier).toBe("enterprise");
    expect(status.features.has("sso")).toBe(true);
    expect(status.features.has("audit-log")).toBe(true);
    expect(status.features.has("slack-interface")).toBe(true);
  });

  it("respects an explicit `features` override array in the JWT", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_partial",
      tier: "pro",
      seats: 5,
      iat: now(),
      exp: now() + 86_400,
      features: ["slack-interface", "sso"], // weird mix for a design partner
    });
    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.features.has("slack-interface")).toBe(true);
    expect(status.features.has("sso")).toBe(true);
    expect(status.features.has("multi-repo")).toBe(false);
  });

  it("rejects an expired JWT with invalidReason='expired'", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "urateam.dev",
      sub: "cust_test",
      tier: "pro",
      seats: 25,
      iat: now() - 100_000,
      exp: now() - 1,
    });
    const status = checkLicense();
    expect(status.licensed).toBe(false);
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("expired");
  });

  it("rejects a wrong-issuer JWT with invalidReason='wrong-issuer'", () => {
    process.env.URATEAM_LICENSE_KEY = makeJwt(privateKey, {
      iss: "evil.dev",
      sub: "cust_test",
      tier: "enterprise",
      seats: null,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("wrong-issuer");
  });

  it("rejects a JWT signed with the wrong key (bad signature)", () => {
    const { privateKey: otherPriv } = generateKeyPairSync("ed25519");
    process.env.URATEAM_LICENSE_KEY = makeJwt(otherPriv, {
      iss: "urateam.dev",
      sub: "cust_test",
      tier: "enterprise",
      seats: null,
      iat: now(),
      exp: now() + 86_400,
    });
    const status = checkLicense();
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("bad-signature");
  });

  it("rejects a malformed JWT (not three parts) with invalidReason='malformed'", () => {
    process.env.URATEAM_LICENSE_KEY = "this.is-not-a-jwt";
    const status = checkLicense();
    expect(status.tier).toBe("oss");
    expect(status.invalidReason).toBe("malformed");
  });
});
```

Also add `afterEach` to the existing imports at the top of the file:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
```

- [ ] **Step 2: Run the new tests, expect failure**

Run: `cd packages/core && npx vitest run src/__tests__/license.test.ts`
Expected: 7 new tests fail (current `checkLicense` always returns OSS when key is set).

- [ ] **Step 3: Replace `checkLicense` body in `packages/core/src/license.ts` with the JWT validation logic**

Add this import at the top of `packages/core/src/license.ts`:

```ts
import { createPublicKey, verify } from "node:crypto";
import * as publicKeyMod from "./license-public-key.js";
```

Replace the body of `checkLicense` (the part after the `if (!key)` early return) with:

```ts
  const result = verifyJwt(key);
  if (!result.ok) {
    cachedStatus = ossStatus(result.reason);
    log.warn({ reason: result.reason }, "license key invalid — running in OSS mode");
    return cachedStatus;
  }

  const claims = result.claims;
  const explicitFeatures = Array.isArray(claims.features) ? new Set(claims.features) : null;
  const features = explicitFeatures ?? new Set(FEATURES_BY_TIER[claims.tier]);

  cachedStatus = {
    licensed: true,
    tier: claims.tier,
    customerId: claims.sub,
    expiresAt: new Date(claims.exp * 1000),
    seats: claims.seats ?? null,
    features,
  };
  log.info(
    { tier: claims.tier, customerId: claims.sub, expiresAt: cachedStatus.expiresAt.toISOString() },
    "license key validated",
  );
  return cachedStatus;
```

Add this helper at the bottom of the file (above `_resetLicenseCache`):

```ts
interface JwtClaims {
  iss: string;
  sub: string;
  tier: Tier;
  seats: number | null | undefined;
  iat: number;
  exp: number;
  features?: string[];
}

type VerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: NonNullable<LicenseStatus["invalidReason"]> };

const ISSUER = "urateam.dev";

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function verifyJwt(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  const [headerB64, payloadB64, sigB64] = parts;

  let claims: JwtClaims;
  try {
    const header = JSON.parse(b64urlDecode(headerB64).toString("utf-8"));
    if (header.alg !== "EdDSA") return { ok: false, reason: "malformed" };
    claims = JSON.parse(b64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(publicKeyMod.LICENSE_PUBLIC_KEY_DER_B64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlDecode(sigB64);
  const valid = verify(null, signingInput, publicKey, signature);
  if (!valid) return { ok: false, reason: "bad-signature" };

  if (claims.iss !== ISSUER) return { ok: false, reason: "wrong-issuer" };

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) {
    return { ok: false, reason: "expired" };
  }

  if (claims.tier !== "oss" && claims.tier !== "pro" && claims.tier !== "enterprise") {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, claims };
}
```

- [ ] **Step 4: Run the tests, expect pass**

Run: `cd packages/core && npx vitest run src/__tests__/license.test.ts`
Expected: all license tests pass (4 OSS tests + 7 JWT tests = 11 total).

- [ ] **Step 5: Build the core package**

Run: `pnpm --filter @urateam/core build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/license.ts packages/core/src/__tests__/license.test.ts
git commit -m "feat(license): Ed25519 JWT validation for license keys"
```

---

## Task 5: Verify existing license consumers still work

**Files:**
- Verify (no expected edits): `packages/core/src/index.ts`, `packages/core/src/server.ts`, `packages/core/src/pipeline/runner.ts`, `packages/core/src/pm/scheduler.ts`

The existing call sites only use `isFeatureLicensed(...)` and read `LicenseStatus.tier`/`.licensed`. The API surface for those is unchanged, so they should compile and run as-is. This task confirms that.

- [ ] **Step 1: Build the whole monorepo**

Run: `pnpm build`
Expected: clean. Any reference to the removed `tier === "free"` or to the old `key` field on `LicenseStatus` would fail here.

- [ ] **Step 2: Run the full unit test suite**

Run: `pnpm test`
Expected: all green. Tests that previously asserted `tier === "free"` need updating — they live in `packages/core/src/__tests__/`. If any fail, update the assertions to expect `"oss"`. Search:

```bash
```
Run: `Grep "tier.*free|\"free\"" packages/core/src/__tests__/`

If results are found, update each occurrence from `"free"` to `"oss"` and re-run `pnpm test`.

- [ ] **Step 3: Commit any test updates**

```bash
git add packages/core/src/__tests__/
git commit -m "test: update tier assertions to 'oss' (was 'free')"
```

(If Step 2 found nothing, skip this commit.)

---

## Task 6: Add the `ura license issue` admin command

**Files:**
- Create: `packages/cli/src/commands/license.ts`
- Create: `packages/cli/src/__tests__/license-command.test.ts`

The command takes the operator's signing key from `URATEAM_LICENSE_SIGNING_KEY_DER_B64` and issues a signed JWT for a customer. Hidden from `--help` (admin-only).

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/license-command.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { issueLicense } from "../commands/license.js";

describe("issueLicense", () => {
  let publicKeyDer: Buffer;
  let originalSigningKey: string | undefined;

  beforeEach(() => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
    originalSigningKey = process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");
  });

  afterEach(() => {
    if (originalSigningKey === undefined) {
      delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    } else {
      process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = originalSigningKey;
    }
  });

  function decodeJwt(token: string): { header: object; payload: Record<string, unknown> } {
    const [h, p] = token.split(".");
    const fromB64Url = (s: string) =>
      Buffer.from(
        s.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (s.length % 4)) % 4),
        "base64",
      ).toString("utf-8");
    return { header: JSON.parse(fromB64Url(h)), payload: JSON.parse(fromB64Url(p)) };
  }

  it("issues a signed JWT with the requested claims", () => {
    const token = issueLicense({
      customerId: "cust_acme",
      tier: "enterprise",
      seats: 100,
      expiresAt: new Date("2027-04-13T00:00:00Z"),
    });

    const { header, payload } = decodeJwt(token);
    expect(header).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(payload.iss).toBe("urateam.dev");
    expect(payload.sub).toBe("cust_acme");
    expect(payload.tier).toBe("enterprise");
    expect(payload.seats).toBe(100);
    expect(payload.exp).toBe(Math.floor(new Date("2027-04-13T00:00:00Z").getTime() / 1000));
  });

  it("produces a JWT whose signature verifies with the matching public key", () => {
    const token = issueLicense({
      customerId: "cust_test",
      tier: "pro",
      seats: 25,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const [h, p, s] = token.split(".");
    const signingInput = Buffer.from(`${h}.${p}`);
    const fromB64Url = (str: string) =>
      Buffer.from(
        str.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (str.length % 4)) % 4),
        "base64",
      );
    const sig = fromB64Url(s);
    const pk = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    expect(verify(null, signingInput, pk, sig)).toBe(true);
  });

  it("throws when URATEAM_LICENSE_SIGNING_KEY_DER_B64 is not set", () => {
    delete process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    expect(() =>
      issueLicense({
        customerId: "cust_test",
        tier: "pro",
        seats: 25,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).toThrow(/URATEAM_LICENSE_SIGNING_KEY_DER_B64/);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd packages/cli && npx vitest run src/__tests__/license-command.test.ts`
Expected: FAIL — `Cannot find module '../commands/license.js'`.

- [ ] **Step 3: Create `packages/cli/src/commands/license.ts`**

```ts
import { Command } from "commander";
import { createPrivateKey, sign } from "node:crypto";

export interface IssueOptions {
  customerId: string;
  tier: "pro" | "enterprise";
  seats: number | null;
  expiresAt: Date;
  features?: string[];
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Sign a urateam license JWT with the operator's Ed25519 private key.
 *
 * The signing key is read from URATEAM_LICENSE_SIGNING_KEY_DER_B64 (base64
 * SPKI/PKCS8 DER, generated by scripts/generate-license-keypair.ts). This
 * key is operator-only and must never enter the urateam runtime.
 */
export function issueLicense(opts: IssueOptions): string {
  const signingKeyB64 = process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
  if (!signingKeyB64) {
    throw new Error(
      "URATEAM_LICENSE_SIGNING_KEY_DER_B64 env var is not set. " +
        "Run scripts/generate-license-keypair.ts to create one.",
    );
  }

  const privateKey = createPrivateKey({
    key: Buffer.from(signingKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });

  const header = { alg: "EdDSA", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: "urateam.dev",
    sub: opts.customerId,
    tier: opts.tier,
    seats: opts.seats,
    iat: now,
    exp: Math.floor(opts.expiresAt.getTime() / 1000),
  };
  if (opts.features) payload.features = opts.features;

  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);

  return `${signingInput}.${b64url(signature)}`;
}

export const licenseCommand = new Command("license")
  .description("(admin) Manage urateam license keys")
  .addCommand(
    new Command("issue")
      .description("Issue a signed urateam license JWT")
      .requiredOption("--customer-id <id>", "Customer identifier (sub claim)")
      .requiredOption("--tier <tier>", "Tier: pro or enterprise")
      .requiredOption("--expires <iso-date>", "Expiry as ISO date (e.g. 2027-04-13)")
      .option("--seats <n>", "Seat count (omit for unlimited / Enterprise default)")
      .option("--features <csv>", "Optional explicit feature list, comma-separated")
      .action((opts: { customerId: string; tier: string; expires: string; seats?: string; features?: string }) => {
        if (opts.tier !== "pro" && opts.tier !== "enterprise") {
          throw new Error(`tier must be 'pro' or 'enterprise', got '${opts.tier}'`);
        }
        const expiresAt = new Date(opts.expires);
        if (Number.isNaN(expiresAt.getTime())) {
          throw new Error(`invalid --expires: '${opts.expires}'`);
        }
        const token = issueLicense({
          customerId: opts.customerId,
          tier: opts.tier,
          seats: opts.seats ? Number.parseInt(opts.seats, 10) : null,
          expiresAt,
          features: opts.features ? opts.features.split(",").map((s) => s.trim()) : undefined,
        });
        console.log(token);
      }),
  );
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd packages/cli && npx vitest run src/__tests__/license-command.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 5: Build the CLI package**

Run: `pnpm --filter @urateam/cli build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/license.ts packages/cli/src/__tests__/license-command.test.ts
git commit -m "feat(cli): add 'ura license issue' admin command"
```

---

## Task 7: Register the license command in the CLI (hidden from --help)

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Modify `packages/cli/src/index.ts`**

Add the import alongside the others:

```ts
import { licenseCommand } from "./commands/license.js";
```

Add the registration at the bottom of the existing block, **before `program.parse()`**:

```ts
// `license` is an operator/admin command — hidden from --help. Operators
// who need it know it exists.
licenseCommand.configureHelp({ visibleCommands: () => [] }); // hide subcommands from grouping
program.addCommand(licenseCommand, { hidden: true });
```

- [ ] **Step 2: Build and verify the command exists**

Run: `pnpm --filter @urateam/cli build`
Expected: clean.

Run from repo root:
```bash
URATEAM_LICENSE_SIGNING_KEY_DER_B64="<paste-private-key-from-task-1>" \
  node packages/cli/dist/index.js license issue --customer-id test --tier pro --expires 2027-12-31 --seats 25
```
Expected: prints a JWT (three dot-separated base64url strings).

- [ ] **Step 3: Verify it does NOT show in `--help`**

Run from repo root: `node packages/cli/dist/index.js --help`
Expected: the output lists `run`, `dev`, `webhook`, `config`, `start`, `migrate` — but **not** `license`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/index.ts
git commit -m "feat(cli): register hidden 'license' admin subcommand"
```

---

## Task 8: End-to-end smoke test — issue + validate

**Files:**
- Create: `packages/core/src/__tests__/license-end-to-end.test.ts`

This test covers the full loop: the CLI's `issueLicense()` produces a JWT that the core's `checkLicense()` accepts. It catches drift between signer and verifier (e.g. claim shape changes, base64 encoding bugs, header format mismatches).

- [ ] **Step 1: Create the end-to-end test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { checkLicense, _resetLicenseCache } from "../license.js";
// CLI test crosses package boundaries via the workspace symlink.
import { issueLicense } from "@urateam/cli/dist/commands/license.js";

describe("license end-to-end (CLI issue → core validate)", () => {
  let originalSigningKey: string | undefined;
  let originalLicenseKey: string | undefined;
  let originalPublicKey: string | undefined;

  beforeEach(async () => {
    _resetLicenseCache();
    originalSigningKey = process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
    originalLicenseKey = process.env.URATEAM_LICENSE_KEY;

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = Buffer.from(
      privateKey.export({ format: "der", type: "pkcs8" }),
    ).toString("base64");

    const mod = await import("../license-public-key.js");
    originalPublicKey = (mod as { LICENSE_PUBLIC_KEY_DER_B64: string }).LICENSE_PUBLIC_KEY_DER_B64;
    Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
      value: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(async () => {
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 = originalSigningKey;
    if (originalLicenseKey === undefined) delete process.env.URATEAM_LICENSE_KEY;
    else process.env.URATEAM_LICENSE_KEY = originalLicenseKey;

    if (originalPublicKey !== undefined) {
      const mod = await import("../license-public-key.js");
      Object.defineProperty(mod, "LICENSE_PUBLIC_KEY_DER_B64", {
        value: originalPublicKey,
        writable: true,
        configurable: true,
      });
    }
  });

  it("CLI-issued enterprise JWT validates and unlocks enterprise features", () => {
    const token = issueLicense({
      customerId: "cust_e2e",
      tier: "enterprise",
      seats: null,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    process.env.URATEAM_LICENSE_KEY = token;

    const status = checkLicense();
    expect(status.licensed).toBe(true);
    expect(status.tier).toBe("enterprise");
    expect(status.customerId).toBe("cust_e2e");
    expect(status.features.has("sso")).toBe(true);
    expect(status.features.has("audit-log")).toBe(true);
  });
});
```

- [ ] **Step 2: Make sure the CLI is built so the import resolves**

Run: `pnpm --filter @urateam/cli build`
Expected: clean.

- [ ] **Step 3: Run the end-to-end test, expect pass**

Run: `cd packages/core && npx vitest run src/__tests__/license-end-to-end.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Run the full test suite as a sanity check**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/__tests__/license-end-to-end.test.ts
git commit -m "test(license): end-to-end CLI issue → core validate"
```

---

## Task 9: CHANGELOG migration note

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the current CHANGELOG to find the Unreleased section**

Use the Read tool on `CHANGELOG.md`.

- [ ] **Step 2: Add migration entries to `## [Unreleased]`**

Replace the `## [Unreleased]` section's `### Added` block with this expanded block:

```markdown
## [Unreleased]

### Added
- `@urateam/cli`: CLI version is now read from `package.json` instead of being hardcoded (#19, #25).
- `@urateam/cli`: new hidden `ura license issue` admin command for generating Ed25519-signed Enterprise license keys.
- `@urateam/core`: license keys are now Ed25519-signed JWTs validated offline against an embedded public key. Replaces the previous "any non-empty key grants Pro" placeholder.

### Changed
- **Breaking (license)**: tier enum renamed from `free | pro | team | enterprise` to `oss | pro | enterprise`. The `team` tier is removed. Code reading `LicenseStatus.tier` should expect `"oss"` where it previously expected `"free"`.
- **Breaking (license)**: `URATEAM_LICENSE_KEY` must now be a valid Ed25519-signed JWT issued by urateam. Existing placeholder keys will fail validation; the system falls back to OSS mode and logs a warning at startup.
- `LicenseStatus` interface gains `features: Set<string>`, `customerId`, `expiresAt`, `seats`, and `invalidReason` fields. The `key` field is removed.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog notes for license JWT migration and tier rename"
```

---

## Task 10: Final verification and PR

**Files:** none

- [ ] **Step 1: Run the full build**

Run: `pnpm build`
Expected: clean.

- [ ] **Step 2: Run the full unit test suite**

Run: `pnpm test`
Expected: all green.

- [ ] **Step 3: Manual smoke test from the repo root**

Generate a signing key for the smoke test (one-time):
```bash
pnpm tsx scripts/generate-license-keypair.ts > /tmp/license-keys.env
source /tmp/license-keys.env
```

(The `source` line uses the variable names printed by the script — verify they match.)

Issue a token:
```bash
TOKEN=$(URATEAM_LICENSE_SIGNING_KEY_DER_B64="$URATEAM_LICENSE_SIGNING_KEY_DER_B64" \
  node packages/cli/dist/index.js license issue \
  --customer-id smoke-test --tier enterprise --expires 2027-12-31)
echo "$TOKEN"
```
Expected: a 3-part JWT.

(Validating against the **embedded** public key requires having Task 1's public key embedded — this smoke test only runs after the operator has done that. If you're testing this plan against a freshly generated keypair, the `checkLicense()` call below will return `bad-signature` because the embedded key won't match. That's expected and correct behaviour — the test confirms the validation rejects unknown keys.)

- [ ] **Step 4: Open a PR**

Create a branch, push, and open a PR titled `feat(license): Ed25519 JWT validation + ura license issue (Phase 0)`. Reference the spec in the body:

```
## Summary
- Replaces the placeholder `checkLicense()` with offline Ed25519 JWT validation
- Renames tier enum: `free|pro|team|enterprise` → `oss|pro|enterprise`
- Adds hidden `ura license issue` admin command for generating signed license JWTs
- New `LicenseStatus` shape with `features: Set<string>`, `customerId`, `expiresAt`, `seats`, `invalidReason`

## Spec
docs/superpowers/specs/2026-04-13-enterprise-tier-design.md § 5

## Test plan
- [x] `pnpm build`
- [x] `pnpm test`
- [x] Smoke test: CLI issues a token, embedded public key validates it
- [x] CLI `license` subcommand hidden from `--help`
```

---

## Self-review notes

**Spec coverage check (against § 5 of the design):**
- § 5.1 architecture (offline JWT, no phone-home, manual Enterprise issuance) → Tasks 1–4, 6, 7
- § 5.2 JWT shape (Ed25519, iss/sub/tier/seats/iat/exp/features, embedded public key) → Tasks 1, 2, 4, 6
- § 5.3 `LicenseStatus` interface (oss|pro|enterprise, features set, customerId, expiresAt, seats, invalidReason) → Task 3
- § 5.3 OSS / invalid / expired / valid behaviour → Task 4 tests
- § 5.4 Stripe webhook handler → **out of scope (separate repo, separate plan)** — explicitly excluded
- § 5.5 `ura license issue` CLI → Tasks 6, 7

The Stripe webhook is the only spec section not in this plan, and it's correctly out of scope per the spec ("This service is out of scope for the urateam monorepo").

**Type consistency check:**
- `Tier` is `"oss" | "pro" | "enterprise"` everywhere it appears
- `LicenseStatus.features` is `Set<string>` in Task 3 and used as `.has()` in Tasks 4 and 8 — consistent
- `IssueOptions.tier` in CLI is narrowed to `"pro" | "enterprise"` (no point issuing OSS keys)
- `JwtClaims` shape in Task 4 verifier matches the payload built in Task 6 issuer (`iss`, `sub`, `tier`, `seats`, `iat`, `exp`, optional `features`)
- `b64url` helper signature is identical in test fixture (Task 4) and CLI implementation (Task 6)

**Placeholder scan:** none — every step has runnable commands or complete code. The only `<PASTE_...>` placeholder is in Task 2 Step 1, which is intentional (the operator pastes the key from Task 1).
