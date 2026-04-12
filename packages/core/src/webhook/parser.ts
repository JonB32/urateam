export interface ParsedStateChange {
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    labels: Array<{ name: string }>;
    priority: number;
    teamId: string;
    projectId?: string;
  };
  previousState: string | null;
  newState: string;
}

export function parseStateChange(
  payload: Record<string, any>,
): ParsedStateChange | null {
  // Only handle Issue updates with state changes
  if (payload.type !== "Issue" || payload.action !== "update") return null;

  // Must have updatedFrom with stateId to be a state change
  if (!payload.updatedFrom?.stateId) return null;

  const data = payload.data;
  if (!data) return null;

  // Extract the new workflow state name
  const newState = data.state?.name;
  if (!newState) return null;

  return {
    issue: {
      id: data.id ?? "",
      identifier: data.identifier ?? "",
      title: data.title ?? "",
      description: data.description ?? "",
      labels: (data.labels ?? []).map((l: any) => ({ name: l.name ?? "" })),
      priority: data.priority ?? 0,
      teamId: data.teamId ?? data.team?.id ?? "",
      projectId: data.projectId ?? data.project?.id,
    },
    previousState: null, // Linear doesn't send the previous state name directly
    newState,
  };
}
