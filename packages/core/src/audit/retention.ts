import { lt } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { createLogger } from "../logger.js";

const log = createLogger({ component: "audit.retention" });

/**
 * Deletes audit_events rows older than `retentionDays`.
 *
 * This is the SOLE authorized mutation on the audit_events table. The
 * audit-immutability lint test grep-checks that no other file in the
 * codebase calls `update(auditEvents)` or `delete(auditEvents)`.
 *
 * Returns the number of rows deleted.
 */
export async function pruneAuditLog(
  db: AnyDb,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000);
  const result = await (db as any)
    .delete(auditEvents)
    .where(lt(auditEvents.timestamp, cutoff));
  const n =
    (result as any)?.changes ?? (result as any)?.rowCount ?? 0;
  log.info(
    { retentionDays, cutoff, deleted: n },
    "audit log pruned",
  );
  return n;
}
