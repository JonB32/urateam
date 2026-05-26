import { asc, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { circuitBreakerState } from "../../db/schema.js";
import type { AnyDb } from "../../db/client.js";
import { batchCountConsecutiveFailures } from "./db-queries.js";
import { createLogger } from "../../logger.js";
import { logAuditEventUnchecked } from "../../audit/writer.js";
import { pmCircuitBreakerProbeEvent } from "../../audit/events.js";

const log = createLogger({ component: "PmAgent:probe" });

export interface SelectProbeCandidatesOptions {
  cap: number;
  cooldownMs: number;
  maxConsecutiveFailures: number;
  now: number;
  /** Escape hatch from `getCircuitBreakerProbeConfig().disabled`. */
  disabled?: boolean;
}

/**
 * BEC-236 — pick at most `cap` circuit-broken issues whose cooldown
 * window has elapsed, mark them probed (`last_probe_at = now`,
 * `probe_attempts += 1`), and emit one `pm.circuit_breaker_probe` audit
 * event per. Returns the issue IDs the caller should bypass the breaker
 * skip for in this tick.
 *
 * Round-robin: candidates are ordered by oldest `last_probe_at` first
 * (NULLs first) so no issue starves.
 */
export async function selectProbeCandidates(
  db: AnyDb,
  opts: SelectProbeCandidatesOptions,
): Promise<Set<string>> {
  if (opts.disabled) return new Set();

  // Defensive: when maxConsecutiveFailures is 0 the breaker is effectively
  // disabled (BEC-181 documents this), so there's nothing to probe — and the
  // downstream filter `count >= 0` would elect every state-row issue,
  // including already-recovered ones.
  if (opts.maxConsecutiveFailures <= 0) return new Set();

  // Pull all eligible rows: cooldown elapsed OR never probed.
  // Drizzle's lte() calls toDriver() on the Date, converting it to epoch-
  // seconds for SQLite (matching how last_probe_at is stored).
  const cooldownCutoff = new Date(opts.now - opts.cooldownMs);
  const rows = (await db
    .select({
      issueId: circuitBreakerState.issueId,
      lastProbeAt: circuitBreakerState.lastProbeAt,
      probeAttempts: circuitBreakerState.probeAttempts,
    })
    .from(circuitBreakerState)
    .where(
      or(
        isNull(circuitBreakerState.lastProbeAt),
        lte(circuitBreakerState.lastProbeAt, cooldownCutoff),
      ),
    )
    .orderBy(
      // NULLs first (never probed → most eligible), then oldest-first.
      sql`CASE WHEN ${circuitBreakerState.lastProbeAt} IS NULL THEN 0 ELSE 1 END`,
      asc(circuitBreakerState.lastProbeAt),
    )) as Array<{ issueId: string; lastProbeAt: Date | null; probeAttempts: number }>;

  if (rows.length === 0) return new Set();

  // Filter out issues whose failure count has dropped (a `completed` run landed).
  const failureCounts = await batchCountConsecutiveFailures(db, rows.map((r) => r.issueId));
  const eligible = rows.filter(
    (r) => (failureCounts.get(r.issueId) ?? 0) >= opts.maxConsecutiveFailures,
  );

  const picked = eligible.slice(0, opts.cap);
  if (picked.length === 0) return new Set();

  const pickedIds = picked.map((r) => r.issueId);

  // Atomically bump last_probe_at + probe_attempts for the picked set.
  await db
    .update(circuitBreakerState)
    .set({
      lastProbeAt: new Date(opts.now),
      probeAttempts: sql`${circuitBreakerState.probeAttempts} + 1`,
    })
    .where(inArray(circuitBreakerState.issueId, pickedIds));

  // Emit one audit event per probe. Best-effort — failures don't block the tick.
  // The "age" we know cheaply here is age since the previous probe (or null
  // for never-probed issues, surfaced as -1). Age since the last actual
  // failure would require a separate query per issue — not worth the N+1.
  for (const r of picked) {
    const lastProbeAgeMin = r.lastProbeAt
      ? Math.floor((opts.now - r.lastProbeAt.getTime()) / 60_000)
      : -1;
    try {
      await logAuditEventUnchecked(
        db,
        pmCircuitBreakerProbeEvent({
          issueId: r.issueId,
          consecutiveFailures: failureCounts.get(r.issueId) ?? 0,
          lastProbeAgeMin,
          probeAttempts: r.probeAttempts + 1,
        }),
      );
    } catch (err) {
      log.warn({ err, issueId: r.issueId }, "failed to log circuit-breaker probe audit event");
    }
  }

  return new Set(pickedIds);
}
