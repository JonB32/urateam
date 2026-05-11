/**
 * PM Agent — Slack command execution.
 *
 * Responsibility: execute a parsed `PmCommand` against the Linear API and return
 * a human-readable response string suitable for posting back to Slack.
 *
 * Extracted from `slack-interface.ts` (BEC-195). The previous implementation
 * accessed `isPmPaused` / `setPmPaused` as module-level closures within
 * `slack-interface.ts`. After the split those functions live in `pause-state.ts`
 * and are imported explicitly here, making the dependency transparent and
 * avoiding a circular import (slack-interface → slack-commands → slack-interface).
 */

import { createLogger } from "../logger.js";
import { createLazyLinearClient } from "./linear-helpers.js";
import { analyzeBulkCreateRequest } from "./slack-bulk.js";
import { isPmPaused, setPmPaused } from "./pause-state.js";

const log = createLogger({ component: "PmAgent:slack-commands" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Linear workflow state name for the Triage column. */
const LINEAR_STATE_TRIAGE = "Triage";
/** Linear workflow state name for the Todo column. */
const LINEAR_STATE_TODO = "Todo";
/** Linear label name that triggers the auto-implement pipeline. */
const LINEAR_LABEL_AUTO_IMPLEMENT = "auto-implement";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured representation of a PM command parsed from Slack text.
 * This type lives here (rather than in `slack-interface.ts`) so that
 * `executePmCommand` owns the shape of the data it operates on, and
 * `slack-interface.ts` can import it without creating a circular dependency.
 */
export type PmCommand =
  | { type: "prioritize"; issueId: string }
  | { type: "create"; title: string; description: string }
  | { type: "bulk_create"; request: string }
  | { type: "status" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "assign"; issueId: string }
  | { type: "unknown"; original: string };

/**
 * Subset of Linear's IssueCreateInput used by this module.
 * Typed explicitly to avoid `any` and catch field-name typos at compile time.
 */
interface LinearIssueCreateInput {
  teamId: string;
  title: string;
  description?: string;
  priority?: number;
  stateId?: string;
  labelIds?: string[];
}

/**
 * External dependencies injected into `executePmCommand`.
 * All fields are optional so callers can pass a partial object during testing.
 */
export interface CommandExecutorDeps {
  /** Linear API key (needed for create / prioritize / assign commands). */
  linearApiKey?: string;
  /** Team IDs for issue creation commands. */
  teamIds?: string[];
  /** Sonnet-model callable required for the `bulk_create` command. */
  callClaudeSonnet?: (prompt: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes a parsed `PmCommand` against Linear and returns a human-readable
 * response string suitable for posting back to Slack.
 *
 * Design note — implicit state access: the `pause` / `resume` / `status`
 * command cases call `isPmPaused()` and `setPmPaused()` from `pause-state.ts`.
 * These functions are now explicit imports rather than closures over outer module
 * state (as they were when this logic lived in `slack-interface.ts`). The
 * dependency is intentional and transparent — the pause flag is process-scoped
 * shared state that must be the same instance for both command execution and the
 * scheduler's `isPmPaused()` check.
 *
 * @param cmd - A structured `PmCommand` (output of `parsePmCommand` or
 *   `interpretNaturalLanguage`).
 * @param deps - External service dependencies (Linear API key, team IDs,
 *   optional Sonnet callable for bulk create).
 * @returns A Slack-formatted response string (may contain mrkdwn markup).
 */
export async function executePmCommand(
  cmd: PmCommand,
  deps: CommandExecutorDeps,
): Promise<string> {
  const { getClient: getLinear } = createLazyLinearClient(deps.linearApiKey);

  /**
   * Searches Linear for an issue by its identifier (e.g. "BEC-25") and returns
   * the first match, or `null` when not found. Shared by prioritize + assign.
   */
  async function findIssueByIdentifier(linear: any, issueId: string): Promise<any | null> {
    const results = await linear.searchIssues(issueId);
    return results.nodes?.[0] ?? null;
  }

  switch (cmd.type) {
    case "status": {
      const state = isPmPaused() ? "⏸ *Paused*" : "▶️ *Running*";
      return `PM Agent is ${state}.\nUse \`/pm pause\` or \`/pm resume\` to control autonomous assignment.`;
    }

    case "pause": {
      setPmPaused(true);
      log.info("PM Agent paused via Slack");
      return "⏸ PM Agent autonomous assignment has been *paused*. Use `/pm resume` to restart.";
    }

    case "resume": {
      setPmPaused(false);
      log.info("PM Agent resumed via Slack");
      return "▶️ PM Agent autonomous assignment has been *resumed*.";
    }

    case "prioritize": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot prioritize *${cmd.issueId}*.`;
      }
      try {
        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot prioritize *${cmd.issueId}*.`;
        const issue = await findIssueByIdentifier(linear, cmd.issueId);
        if (!issue) return `⚠️ Issue *${cmd.issueId}* not found in Linear.`;
        // updateIssue and createComment are independent — run in parallel
        await Promise.all([
          linear.updateIssue(issue.id, { priority: 1 }),
          linear.createComment({
            issueId: issue.id,
            body: "🤖 **PM Agent** — Bumped to top of queue via Slack command.",
          }),
        ]);
        log.info({ issueId: cmd.issueId }, "prioritized via Slack");
        return `✅ *${cmd.issueId}* has been bumped to top priority (Urgent).`;
      } catch (err) {
        log.error({ err, issueId: cmd.issueId }, "prioritize failed");
        return `❌ Failed to prioritize *${cmd.issueId}*: ${(err as Error).message}`;
      }
    }

    case "assign": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot assign *${cmd.issueId}*.`;
      }
      try {
        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot assign *${cmd.issueId}*.`;
        const issue = await findIssueByIdentifier(linear, cmd.issueId);
        if (!issue) return `⚠️ Issue *${cmd.issueId}* not found in Linear.`;

        const team = await issue.team;
        const allStates = await linear.workflowStates({
          filter: { team: { id: { eq: team?.id } } },
          first: 50,
        });
        const todoState = allStates.nodes?.find((s: any) => s.name === LINEAR_STATE_TODO);
        if (!todoState) return `⚠️ No "${LINEAR_STATE_TODO}" state found for *${cmd.issueId}*'s team.`;

        await linear.updateIssue(issue.id, { stateId: todoState.id });
        await linear.createComment({
          issueId: issue.id,
          body: "🤖 **PM Agent** — Manually assigned to Todo via Slack command.",
        });
        log.info({ issueId: cmd.issueId }, "manually assigned to Todo via Slack");
        return `✅ *${cmd.issueId}* has been moved to Todo.`;
      } catch (err) {
        log.error({ err, issueId: cmd.issueId }, "assign failed");
        return `❌ Failed to assign *${cmd.issueId}*: ${(err as Error).message}`;
      }
    }

    case "create": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot create issue.`;
      }
      if (!deps.teamIds || deps.teamIds.length === 0) {
        return `⚠️ No team IDs configured — cannot create issue.`;
      }
      try {
        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot create issue.`;
        const created = await linear.createIssue({
          teamId: deps.teamIds[0],
          title: cmd.title,
          description: cmd.description || undefined,
        });
        const issue = await created.issue;
        const url = issue?.url ?? "";
        log.info({ title: cmd.title, issueId: issue?.identifier }, "issue created via Slack");
        return `✅ Created <${url}|${issue?.identifier ?? "new issue"}>: *${cmd.title}*`;
      } catch (err) {
        log.error({ err, title: cmd.title }, "create issue failed");
        return `❌ Failed to create issue: ${(err as Error).message}`;
      }
    }

    case "bulk_create": {
      if (!deps.linearApiKey) {
        return `⚠️ No Linear API key configured — cannot create issues.`;
      }
      if (!deps.teamIds || deps.teamIds.length === 0) {
        return `⚠️ No team IDs configured — cannot create issues.`;
      }
      if (!deps.callClaudeSonnet) {
        return `⚠️ Bulk create requires a Sonnet model caller — not configured.`;
      }
      try {
        const specs = await analyzeBulkCreateRequest(cmd.request, deps.callClaudeSonnet);
        if (specs.length === 0) {
          return `🤔 Could not generate any issues from your request. Try being more specific.`;
        }

        const linear = await getLinear();
        if (!linear) return `⚠️ No Linear API key configured — cannot create issues.`;

        // Resolve the Triage state and auto-implement label IDs
        const teamId = deps.teamIds[0];
        const [allStatesRes, allLabelsRes] = await Promise.all([
          linear.workflowStates({ filter: { team: { id: { eq: teamId } } }, first: 50 }),
          linear.issueLabels({ first: 100 }),
        ]);
        const triageState = allStatesRes.nodes?.find((s: any) => s.name === LINEAR_STATE_TRIAGE);
        const labelMap = new Map<string, string>();
        for (const label of allLabelsRes.nodes ?? []) {
          labelMap.set(label.name.toLowerCase(), label.id);
        }
        const autoImplementLabelId = labelMap.get(LINEAR_LABEL_AUTO_IMPLEMENT);

        // Build all payloads first, then create all issues in parallel
        const payloads: LinearIssueCreateInput[] = specs.map((spec) => {
          const descWithCriteria =
            spec.acceptanceCriteria.length > 0
              ? `${spec.description}\n\n**Acceptance Criteria:**\n${spec.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}`
              : spec.description;

          const payload: LinearIssueCreateInput = {
            teamId,
            title: spec.title,
            description: descWithCriteria || undefined,
            priority: spec.priority,
          };
          if (triageState) payload.stateId = triageState.id;
          if (autoImplementLabelId) payload.labelIds = [autoImplementLabelId];
          return payload;
        });

        const results = await Promise.all(payloads.map((p) => linear.createIssue(p)));
        const issueObjects = await Promise.all(results.map((r: any) => r.issue));

        const created: Array<{ identifier: string; url: string; title: string }> = [];
        for (let i = 0; i < issueObjects.length; i++) {
          const issue = issueObjects[i];
          if (issue) {
            const title = specs[i].title;
            created.push({ identifier: issue.identifier ?? "", url: issue.url ?? "", title });
            log.info({ issueId: issue.identifier, title }, "bulk issue created via Slack");
          }
        }

        if (created.length === 0) {
          return `❌ Failed to create any issues.`;
        }

        const lines = [`✅ Created ${created.length} issue${created.length === 1 ? "" : "s"}:`];
        for (const issue of created) {
          const link = issue.url ? `<${issue.url}|${issue.identifier}>` : `*${issue.identifier}*`;
          lines.push(`• ${link}: *${issue.title}*`);
        }
        return lines.join("\n");
      } catch (err) {
        log.error({ err, request: cmd.request }, "bulk create failed");
        return `❌ Failed to create issues: ${(err as Error).message}`;
      }
    }

    case "unknown":
      return `🤔 I didn't understand that. Try:\n• \`/pm status\`\n• \`/pm prioritize BEC-25\`\n• \`/pm create "title" "description"\`\n• \`/pm assign BEC-13\`\n• \`/pm pause\` / \`/pm resume\``;

    default:
      return `Unknown command.`;
  }
}
