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
 * The signing key is read from URATEAM_LICENSE_SIGNING_KEY (preferred) or
 * URATEAM_LICENSE_SIGNING_KEY_DER_B64 (deprecated, kept for backwards
 * compatibility). Both accept either raw base64 PKCS8 DER (as emitted by
 * scripts/generate-license-keypair.ts) or a PEM-wrapped PKCS8 string (as
 * emitted by the urateam-licensing Worker's gen-signing-key.ts). The key
 * is operator-only and must never enter the urateam runtime.
 */
export function issueLicense(opts: IssueOptions): string {
  const raw =
    process.env.URATEAM_LICENSE_SIGNING_KEY ??
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64;
  if (!raw) {
    throw new Error(
      "URATEAM_LICENSE_SIGNING_KEY env var is not set. " +
        "Run scripts/generate-license-keypair.ts to create one.",
    );
  }
  if (
    process.env.URATEAM_LICENSE_SIGNING_KEY === undefined &&
    process.env.URATEAM_LICENSE_SIGNING_KEY_DER_B64 !== undefined
  ) {
    console.warn(
      "URATEAM_LICENSE_SIGNING_KEY_DER_B64 is deprecated; rename to URATEAM_LICENSE_SIGNING_KEY (same value, both PEM and base64 DER accepted).",
    );
  }

  const privateKey = raw.includes("BEGIN PRIVATE KEY")
    ? createPrivateKey({ key: raw, format: "pem", type: "pkcs8" })
    : createPrivateKey({
        key: Buffer.from(raw.trim(), "base64"),
        format: "der",
        type: "pkcs8",
      });

  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `URATEAM_LICENSE_SIGNING_KEY must be an Ed25519 key, got ${privateKey.asymmetricKeyType}. ` +
        "JWT header advertises alg=EdDSA — signing with any other key type would produce an unverifiable token.",
    );
  }

  const header = { alg: "EdDSA", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: "urateams.com",
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
        let seats: number | null = null;
        if (opts.seats !== undefined) {
          const parsed = Number.parseInt(opts.seats, 10);
          if (Number.isNaN(parsed) || parsed <= 0) {
            throw new Error(`--seats must be a positive integer, got '${opts.seats}'`);
          }
          seats = parsed;
        }
        const token = issueLicense({
          customerId: opts.customerId,
          tier: opts.tier,
          seats,
          expiresAt,
          features: opts.features ? opts.features.split(",").map((s) => s.trim()) : undefined,
        });
        console.log(token);
      }),
  );
