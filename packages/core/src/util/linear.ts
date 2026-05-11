/**
 * Shared Linear SDK utilities.
 *
 * Three helpers that eliminate duplicated boilerplate across the PM Agent and
 * notifier modules:
 *
 * - `getLinearClient(apiKey)` — module-level cached LinearClient factory.
 *   Calling with the same API key always returns the same instance; calling with
 *   undefined/empty returns null (safe to use before the key is configured).
 *
 * - `resolveIssueRelations(issue)` — concurrently fetches team, state, and
 *   labels from a Linear SDK Issue object via Promise.all, replacing the common
 *   sequential-await pattern that wastes 2–3 SDK round-trips per issue.
 *
 * - `resolveWorkflowStatesByTeam(linearClient, teamIds)` — parallelizes all
 *   `state.team` relation fetches when building the `${teamId}:${stateName}`
 *   → stateId map, replacing the serial-await loop in resolveWorkflowStates.
 */

// Module-level cache so callers with the same API key share one SDK client
// instance rather than re-constructing it on every PM tick.
const _clientCache = new Map<string, any>();

/**
 * Returns a cached LinearClient for the given API key.
 *
 * The client is instantiated lazily on first call and reused for subsequent
 * calls with the same key, avoiding redundant SDK imports and client
 * construction on every PM tick.
 *
 * @param apiKey Linear API key. Returns `null` when undefined/empty.
 */
export async function getLinearClient(
  apiKey: string | undefined,
): Promise<any> {
  if (!apiKey) return null;
  if (_clientCache.has(apiKey)) return _clientCache.get(apiKey);
  const { LinearClient } = await import("@linear/sdk");
  const client = new LinearClient({ apiKey });
  _clientCache.set(apiKey, client);
  return client;
}

/**
 * Clears the module-level LinearClient cache.
 * Exposed for unit tests only — do NOT call in production code.
 */
export function _clearLinearClientCache(): void {
  _clientCache.clear();
}

/**
 * Concurrently resolves the lazy team, state, and labels relations on a
 * Linear SDK issue object.
 *
 * Replaces the common sequential-await pattern:
 * ```ts
 * // Before (3 serial SDK round-trips)
 * const team  = await issue.team;
 * const state = await issue.state;
 * const labels = await issue.labels();
 *
 * // After (1 Promise.all round, same latency as slowest call)
 * const { team, state, labels } = await resolveIssueRelations(issue);
 * ```
 *
 * @param issue A Linear SDK Issue object (or compatible mock with the same shape)
 * @returns     `{ team, state, labels }` — the resolved relation values
 */
export async function resolveIssueRelations(issue: any): Promise<{
  team: any;
  state: any;
  labels: any;
}> {
  // The Linear SDK exposes labels as a callable method (`issue.labels()`).
  // Some test fixtures use plain objects here instead; guard against that by
  // only calling when labels is a function.
  const labelsPromise =
    typeof issue.labels === "function" ? issue.labels() : undefined;

  const [team, state, labels] = await Promise.all([
    issue.team,
    issue.state,
    labelsPromise,
  ]);
  return { team, state, labels };
}

/**
 * Fetches workflow states for the given teams and returns a
 * `${teamId}:${stateName}` → stateId map.
 *
 * All `state.team` relation fetches are parallelized via Promise.all,
 * replacing the serial-await loop that previously made N SDK calls
 * sequentially (one per state node).
 *
 * @param linearClient Any LinearClient (or compatible mock)
 * @param teamIds      Array of Linear team UUIDs to fetch states for
 * @returns            Map from `${teamId}:${stateName}` to state ID
 */
export async function resolveWorkflowStatesByTeam(
  linearClient: any,
  teamIds: string[],
): Promise<Map<string, string>> {
  const allStates = await linearClient.workflowStates({
    filter: { team: { id: { in: teamIds } } },
    first: 100,
  });
  const nodes: any[] = allStates.nodes ?? [];

  // Resolve all state.team relations in parallel (replaces serial await loop)
  const teams = await Promise.all(nodes.map((s: any) => s.team));

  const stateMap = new Map<string, string>();
  for (let i = 0; i < nodes.length; i++) {
    const state = nodes[i];
    const team = teams[i];
    const teamId = team?.id;
    if (teamId) stateMap.set(`${teamId}:${state.name}`, state.id);
  }
  return stateMap;
}
