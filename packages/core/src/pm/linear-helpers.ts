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
