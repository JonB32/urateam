import type { LinearClient } from "@linear/sdk";
import { getLinearClient, resolveWorkflowStatesByTeam } from "../util/linear.js";

/**
 * Creates a lazy-initialized Linear client singleton.
 * The client is instantiated on the first call to `getClient()` and reused
 * thereafter — avoids redundant SDK imports on every PM tick.
 *
 * Usage:
 *   const { getClient } = createLazyLinearClient(deps.linearApiKey);
 *   const linear = await getClient(); // null if apiKey is undefined
 *
 * @param apiKey Linear API key. When undefined/empty, `getClient()` returns null.
 *
 * @deprecated Prefer `getLinearClient(apiKey)` from `util/linear.ts` directly.
 *   This wrapper is retained for backwards compatibility with existing callers.
 */
export function createLazyLinearClient(apiKey: string | undefined): {
  getClient: () => Promise<LinearClient | null>;
} {
  return {
    getClient: () => getLinearClient(apiKey),
  };
}

/**
 * Fetches workflow states for the given teams and builds a
 * `${teamId}:${stateName}` → stateId map.
 *
 * Delegates to `resolveWorkflowStatesByTeam` from `util/linear.ts`, which
 * parallelizes all `state.team` relation fetches via Promise.all.
 */
export async function resolveWorkflowStates(
  linearClient: Pick<LinearClient, "workflowStates">,
  teamIds: string[],
): Promise<Map<string, string>> {
  return resolveWorkflowStatesByTeam(linearClient, teamIds);
}
