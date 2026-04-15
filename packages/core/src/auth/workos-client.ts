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
 */
export async function getDefaultWorkosClient(apiKey: string): Promise<WorkosClient> {
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
