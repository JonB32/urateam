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
export async function bootstrapSsoFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SsoBootstrapResult | undefined> {
  if (env.URATEAM_SSO_ENABLED !== "true") return undefined;

  const required = {
    URATEAM_WORKOS_API_KEY: env.URATEAM_WORKOS_API_KEY,
    URATEAM_WORKOS_CLIENT_ID: env.URATEAM_WORKOS_CLIENT_ID,
    URATEAM_WORKOS_REDIRECT_URI: env.URATEAM_WORKOS_REDIRECT_URI,
    URATEAM_SSO_STATE_SECRET: env.URATEAM_SSO_STATE_SECRET,
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

  const { SsoConfigSchema, getDefaultWorkosClient } = await import(
    "@urateam/core"
  );

  let sso: SsoConfig;
  try {
    sso = SsoConfigSchema.parse({
      enabled: true,
      workosApiKey: required.URATEAM_WORKOS_API_KEY,
      workosClientId: required.URATEAM_WORKOS_CLIENT_ID,
      redirectUri: required.URATEAM_WORKOS_REDIRECT_URI,
      allowedDomain: env.URATEAM_SSO_ALLOWED_DOMAIN || undefined,
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

  const workos = await getDefaultWorkosClient(sso.workosApiKey);
  return { sso, workos };
}
