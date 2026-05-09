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
 */
export function createLazyLinearClient(apiKey: string | undefined): {
  getClient: () => Promise<any>;
} {
  let _client: any = null;
  return {
    async getClient() {
      if (!_client && apiKey) {
        const { LinearClient } = await import("@linear/sdk");
        _client = new LinearClient({ apiKey });
      }
      return _client;
    },
  };
}

export async function resolveWorkflowStates(
  linearClient: any,
  teamIds: string[],
): Promise<Map<string, string>> {
  const allStates = await linearClient.workflowStates({
    filter: { team: { id: { in: teamIds } } },
    first: 100,
  });
  const stateMap = new Map<string, string>();
  for (const state of allStates.nodes ?? []) {
    // state.team is a lazy relation in the Linear SDK — must await to resolve
    const team = await state.team;
    const teamId = team?.id;
    if (teamId) stateMap.set(`${teamId}:${state.name}`, state.id);
  }
  return stateMap;
}
