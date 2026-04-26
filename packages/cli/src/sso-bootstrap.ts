import type { SsoConfig, WorkosClient } from "@urateam/core";

export interface SsoBootstrapResult {
  sso: SsoConfig;
  workos: WorkosClient;
}

/**
 * Read SSO-related env vars and, if `URATEAM_SSO_ENABLED === "true"`, build a
 * validated `SsoConfig` and resolve a default WorkOS client. If SSO is
 * disabled, returns `undefined`. If SSO is enabled but a required env var is
 * missing, logs an error and exits the process (per spec § 6).
 *
 * Required env vars when enabled:
 *   - URATEAM_WORKOS_API_KEY
 *   - URATEAM_WORKOS_CLIENT_ID
 *   - URATEAM_WORKOS_REDIRECT_URI
 *   - URATEAM_SSO_STATE_SECRET
 * Optional:
 *   - URATEAM_SSO_ALLOWED_DOMAIN
 *   - URATEAM_SSO_SESSION_HOURS (default 24)
 *   - URATEAM_SSO_COOKIE_NAME (default "urateam_session")
 *   - URATEAM_SSO_COOKIE_SECURE (default "true")
 */
function trimEnv(v: string | undefined): string | undefined {
  return v?.trim() || undefined;
}

export async function bootstrapSsoFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SsoBootstrapResult | undefined> {
  const enabledRaw = trimEnv(env.URATEAM_SSO_ENABLED);
  if (!enabledRaw) return undefined;
  const enabledLower = enabledRaw.toLowerCase();
  if (enabledLower !== "true") {
    // Refuse silently-falsy values like "false"/"no"/"0" without warning,
    // but anything else is almost certainly a misconfigured truthy value
    // (e.g. "True", "yes", "1") — warn loudly so it shows up in startup logs.
    if (!["false", "no", "0", "off"].includes(enabledLower)) {
      console.warn(
        `URATEAM_SSO_ENABLED=${enabledRaw} is not a recognized boolean. ` +
          `SSO will NOT be enabled. Use "true" to enable.`,
      );
    }
    return undefined;
  }

  const required = {
    URATEAM_WORKOS_API_KEY: trimEnv(env.URATEAM_WORKOS_API_KEY),
    URATEAM_WORKOS_CLIENT_ID: trimEnv(env.URATEAM_WORKOS_CLIENT_ID),
    URATEAM_WORKOS_REDIRECT_URI: trimEnv(env.URATEAM_WORKOS_REDIRECT_URI),
    URATEAM_SSO_STATE_SECRET: trimEnv(env.URATEAM_SSO_STATE_SECRET),
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(
      `URATEAM_SSO_ENABLED=true but the following env vars are missing: ${missing.join(", ")}. ` +
        `Set them and restart, or unset URATEAM_SSO_ENABLED to run without SSO.`,
    );
    process.exit(1);
  }

  const { SsoConfigSchema, getDefaultWorkosClient, LicenseRequiredError } = await import(
    "@urateam/core"
  );

  let sso: SsoConfig;
  try {
    sso = SsoConfigSchema.parse({
      enabled: true,
      workosApiKey: required.URATEAM_WORKOS_API_KEY,
      workosClientId: required.URATEAM_WORKOS_CLIENT_ID,
      redirectUri: required.URATEAM_WORKOS_REDIRECT_URI,
      allowedDomain: trimEnv(env.URATEAM_SSO_ALLOWED_DOMAIN),
      sessionDurationHours: env.URATEAM_SSO_SESSION_HOURS
        ? parseInt(env.URATEAM_SSO_SESSION_HOURS, 10)
        : 24,
      cookieName: env.URATEAM_SSO_COOKIE_NAME || "urateam_session",
      cookieSecure: env.URATEAM_SSO_COOKIE_SECURE !== "false",
      stateSigningSecret: required.URATEAM_SSO_STATE_SECRET,
    });
  } catch (err) {
    console.error("SSO config validation failed:", (err as Error).message);
    process.exit(1);
  }

  let workos;
  try {
    workos = await getDefaultWorkosClient(sso.workosApiKey);
  } catch (err) {
    if (err instanceof LicenseRequiredError) {
      console.error(
        `URATEAM_SSO_ENABLED=true but the "sso" feature requires an enterprise license. ` +
          `Current tier: ${err.actualTier}. ` +
          `Either unset URATEAM_SSO_ENABLED or contact support@urateams.com to upgrade.`,
      );
      process.exit(1);
    }
    throw err;
  }
  return { sso, workos };
}
