import type { AnyDb } from "../db/client.js";
import type { Policy } from "../types.js";
import {
  evaluatePathBlocklist,
  evaluateCostGate,
  hasOverrideLabel,
  type PolicyViolation,
} from "./index.js";
import {
  logAuditEvent,
  policyPathBlockedEvent,
  policyCostExceededEvent,
  policyOverrideUsedEvent,
} from "../audit/index.js";

export interface PolicyGateInput {
  db: AnyDb;
  runId: string;
  issue: { id: string; labels: () => Promise<{ nodes: Array<{ name: string }> }> };
  policy: Policy | undefined;
  changedFiles: string[];
  tokensUsed: number;
  stage: string;
}

export interface PolicyGateResult {
  violations: PolicyViolation[];
  overrideActive: boolean;
  shouldDraft: boolean;
}

/**
 * Orchestrates path + cost policy gates, emits audit events, and reports
 * whether the PR should be forced to draft. Testable seam called by the
 * pipeline runner after the implement stage (and again with cost-only
 * checks after test/review stages).
 */
export async function evaluatePolicyGates(
  input: PolicyGateInput,
): Promise<PolicyGateResult> {
  if (!input.policy) {
    return { violations: [], overrideActive: false, shouldDraft: false };
  }

  const overrideActive = await hasOverrideLabel(
    input.issue,
    input.policy.overrideLabel,
  );
  const pathViolations = evaluatePathBlocklist(
    input.changedFiles,
    input.policy.pathBlocklist,
  );
  const costViolation = evaluateCostGate(
    input.tokensUsed,
    input.policy.maxTokensPerIssue,
    input.stage,
  );

  const all: PolicyViolation[] = [
    ...pathViolations,
    ...(costViolation ? [costViolation] : []),
  ];

  if (all.length === 0) {
    return { violations: [], overrideActive: false, shouldDraft: false };
  }

  if (overrideActive) {
    void logAuditEvent(
      input.db,
      policyOverrideUsedEvent({
        runId: input.runId,
        issueId: input.issue.id,
        gateType: pathViolations.length > 0 ? "path" : "cost",
        label: input.policy.overrideLabel,
      }),
    );
    return { violations: all, overrideActive: true, shouldDraft: false };
  }

  for (const v of pathViolations) {
    void logAuditEvent(
      input.db,
      policyPathBlockedEvent({
        runId: input.runId,
        path: v.payload.path as string,
        pattern: v.payload.pattern as string,
        hadOverride: false,
      }),
    );
  }
  if (costViolation) {
    void logAuditEvent(
      input.db,
      policyCostExceededEvent({
        runId: input.runId,
        tokensUsed: costViolation.payload.tokensUsed as number,
        limit: costViolation.payload.limit as number,
        stage: costViolation.payload.stage as string,
        hadOverride: false,
      }),
    );
  }

  return { violations: all, overrideActive: false, shouldDraft: true };
}
