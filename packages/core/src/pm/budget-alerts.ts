import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { AnyDb } from "../db/client.js";
import { budgetAlerts } from "../db/schema.js";
import type {
  BudgetEvaluation,
  BudgetScope,
  BudgetTier,
  ScopeBudget,
} from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "PmAgent:budget-alerts" });

export type PostSlackMessage = (
  channel: string,
  blocks: unknown,
) => Promise<void>;

/**
 * Fire Slack messages for newly-crossed budget thresholds in the given
 * evaluation. Dedups via the `budget_alerts` table's UNIQUE constraint on
 * (date, scope, threshold) — the first call of the day that observes a
 * crossing inserts the row and posts the message; subsequent calls see
 * the conflict and do nothing.
 *
 * Scopes at tier 'ok' are skipped. For scopes above 'ok', every threshold
 * the scope has reached is evaluated independently (cumulative):
 *   - tier 'warn-50' → only the 50 threshold
 *   - tier 'warn-80' → 50 and 80 thresholds
 *   - tier 'blocked-100' → 50, 80, and 100 thresholds
 */
export async function maybeFireAlerts(
  evaluation: BudgetEvaluation,
  db: AnyDb,
  postSlack: PostSlackMessage,
  channel: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  for (const scope of evaluation.scopes) {
    if (scope.tier === "ok") continue;

    for (const threshold of thresholdsForTier(scope.tier)) {
      const scopeKey = scopeToKey(scope.scope);
      const inserted = await tryInsertAlert(db, today, scopeKey, threshold);
      if (!inserted) continue;

      try {
        await postSlack(channel, buildAlertBlocks(scope, threshold));
      } catch (err) {
        log.error(
          { err, scope: scopeKey, threshold },
          "failed to post budget alert to slack — rolling back dedup row so next tick retries",
        );
        // Compensating delete: if the post failed, remove the dedup row so the
        // next call to maybeFireAlerts re-inserts and re-posts. Without this
        // rollback, a transient Slack outage would silently lose the alert
        // for the rest of the UTC day.
        try {
          await db
            .delete(budgetAlerts)
            .where(
              and(
                eq(budgetAlerts.date, today),
                eq(budgetAlerts.scope, scopeKey),
                eq(budgetAlerts.threshold, threshold),
              ),
            );
        } catch (delErr) {
          log.error(
            { err: delErr, scope: scopeKey, threshold },
            "failed to roll back budget_alerts row after slack post failure",
          );
        }
      }
    }
  }
}

function thresholdsForTier(tier: BudgetTier): number[] {
  if (tier === "blocked-100") return [50, 80, 100];
  if (tier === "warn-80") return [50, 80];
  if (tier === "warn-50") return [50];
  return [];
}

function scopeToKey(scope: BudgetScope): string {
  if (scope.kind === "global") return "global";
  if (scope.kind === "team") return `team:${scope.teamId}`;
  return `repo:${scope.repoUrl}`;
}

async function tryInsertAlert(
  db: AnyDb,
  date: string,
  scopeKey: string,
  threshold: number,
): Promise<boolean> {
  try {
    const result = await db
      .insert(budgetAlerts)
      .values({
        id: nanoid(),
        date,
        scope: scopeKey,
        threshold,
      })
      .onConflictDoNothing()
      .returning({ id: budgetAlerts.id });
    return (result as Array<{ id: string }>).length > 0;
  } catch (err) {
    log.error(
      { err, scopeKey, threshold },
      "failed to insert budget_alerts row",
    );
    return false;
  }
}

function buildAlertBlocks(scope: ScopeBudget, threshold: number): unknown[] {
  const isBlocked = threshold === 100;
  const emoji = isBlocked ? ":no_entry_sign:" : ":warning:";
  const title = `${emoji} urateam budget alert — ${scope.scopeLabel} at ${scope.percent}%`;
  const usage = `${scope.used.toLocaleString()} / ${scope.limit.toLocaleString()} tokens used today`;
  const footer = isBlocked
    ? "New pipeline runs blocked. Increase the cap or wait for midnight UTC reset. Active runs continue to completion."
    : `Threshold: ${threshold}%`;

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*\n${usage}\n${footer}` },
    },
  ];
}
