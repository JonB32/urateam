import { checkLicense, LicenseRequiredError } from "../license.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "auth.workos" });

/**
 * Thin interface over @workos-inc/node so tests can inject a stub
 * without importing the SDK or hitting the network.
 */
export interface WorkosAuthorizeArgs {
  clientId: string;
  redirectUri: string;
  state: string;
}

export interface WorkosAuthenticateArgs {
  clientId: string;
  code: string;
}

export interface WorkosUserProfile {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface WorkosAuthenticateResult {
  user: WorkosUserProfile;
}

export interface WorkosClient {
  getAuthorizationUrl(args: WorkosAuthorizeArgs): Promise<string>;
  authenticateWithCode(args: WorkosAuthenticateArgs): Promise<WorkosAuthenticateResult>;
}

let cached: WorkosClient | null = null;

/**
 * Default WorkOS client. Lazily instantiates the SDK on first use so test
 * environments that never call this never need the SDK installed.
 *
 * NOTE: The singleton cache is not keyed on apiKey. If the API key is
 * rotated, the process must be restarted to pick up the new key. The cache
 * is also coupled to the license cache: if a future change introduces
 * in-process license refresh (see `_resetLicenseCache`), call
 * `_resetWorkosClient()` too so the next call re-evaluates the gate.
 *
 * Throws `LicenseRequiredError` if the `sso` feature is not licensed. This is
 * a defensive library-boundary gate: even though dashboard wiring already
 * skips SSO mounting in OSS mode, any direct caller of this function (CLI
 * bootstrap, future routes, third-party integrations) cannot accidentally
 * load the WorkOS SDK without a license.
 */
export async function getDefaultWorkosClient(apiKey: string): Promise<WorkosClient> {
  const status = checkLicense();
  if (!status.features.has("sso")) {
    log.warn(
      { feature: "sso", tier: status.tier },
      "getDefaultWorkosClient called without an enterprise license — refusing to load WorkOS SDK",
    );
    throw new LicenseRequiredError("sso", status.tier);
  }
  if (cached) return cached;
  // Dynamic import so the dep is loaded only when actually used.
  // The SDK lives in @urateam/dashboard (the only package that activates SSO),
  // so core does not declare it as a dependency. Suppress the missing-types
  // error here — the dashboard provides the resolved module at runtime.
  // @ts-expect-error — @workos-inc/node is an optional runtime dep provided by dashboard
  const { WorkOS } = await import("@workos-inc/node");
  const workos: any = new WorkOS(apiKey);
  cached = {
    async getAuthorizationUrl(args) {
      return workos.userManagement.getAuthorizationUrl({
        clientId: args.clientId,
        redirectUri: args.redirectUri,
        state: args.state,
        provider: "authkit",
      });
    },
    async authenticateWithCode(args) {
      const result = await workos.userManagement.authenticateWithCode({
        clientId: args.clientId,
        code: args.code,
      });
      return {
        user: {
          id: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName ?? null,
          lastName: result.user.lastName ?? null,
        },
      };
    },
  };
  return cached;
}

/** Test-only: reset the cached client. */
export function _resetWorkosClient(): void {
  cached = null;
}
