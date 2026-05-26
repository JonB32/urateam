// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared utilities for Linear webhook integrations (Sentry, CloudWatch).
 */

import { getLinearClient } from "../util/linear.js";

export const BUG_LABEL_NAME = "bug";
export const AUTO_IMPLEMENT_LABEL_NAME = "auto-implement";

/**
 * Common Linear API surface needed by all webhook integrations.
 * Satisfied by the real LinearClient and by test mocks.
 */
export interface IntegrationLinearClient {
  issues(args: { filter: object; first?: number }): Promise<{ nodes: Array<{ id: string; identifier: string; title: string }> }>;
  workflowStates(args: { filter: object }): Promise<{ nodes: Array<{ id: string; name: string }> }>;
  issueLabels(args: { filter: object; first?: number }): Promise<{ nodes: Array<{ id: string; name: string }> }>;
  createIssue(input: {
    teamId: string;
    title: string;
    description: string;
    stateId: string;
    labelIds?: string[];
    priority?: number;
  }): Promise<{ issue?: { id: string; identifier: string } | null }>;
}

/**
 * Create a LinearClient wrapper satisfying IntegrationLinearClient.
 * Both Sentry and CloudWatch integrations share this factory to avoid duplication.
 *
 * @param apiKey Linear Personal API key
 */
export async function createIntegrationLinearClient<T extends IntegrationLinearClient>(
  apiKey: string,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = (await getLinearClient(apiKey)) as any;
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async issues(args) { return client.issues(args); },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async workflowStates(args) { return client.workflowStates(args); },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async issueLabels(args) { return client.issueLabels(args); },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    async createIssue(input) { return client.createIssue(input); },
  } as T;
}

/**
 * Fetch the 'bug' and 'auto-implement' label IDs for a Linear team.
 * Returns the resolved IDs and the names of any labels that were not found.
 *
 * @param linearClient IntegrationLinearClient instance
 * @param teamId Linear team UUID
 */
export async function resolveIntegrationLabels(
  linearClient: IntegrationLinearClient,
  teamId: string,
): Promise<{ labelIds: string[]; missingLabels: string[] }> {
  const labelsResp = await linearClient.issueLabels({
    filter: { team: { id: { eq: teamId } } },
    first: 100,
  });
  const missingLabels: string[] = [];
  const bugLabel = labelsResp.nodes.find((l) => l.name === BUG_LABEL_NAME);
  const autoImplLabel = labelsResp.nodes.find((l) => l.name === AUTO_IMPLEMENT_LABEL_NAME);
  if (!bugLabel) missingLabels.push(BUG_LABEL_NAME);
  if (!autoImplLabel) missingLabels.push(AUTO_IMPLEMENT_LABEL_NAME);
  const labelIds = [bugLabel?.id, autoImplLabel?.id].filter((id): id is string => !!id);
  return { labelIds, missingLabels };
}
