import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { logger } from "../lib/logger.js"

/**
 * Hard-delete collaborative docs that have been soft-deleted for longer than
 * the recovery window. The FK on yjs_updates.doc_id is ON DELETE CASCADE, so
 * the associated update rows are removed atomically with the parent doc.
 *
 * 30 days is the default window — long enough to recover an accidental pentest
 * report deletion before the client has fetched a fresh workspace snapshot,
 * short enough that stale history doesn't sit around indefinitely.
 */
const RECOVERY_WINDOW_DAYS = 30

export async function purgeDeletedDocs(): Promise<void> {
  const result = await db.execute<{ id: string }>(sql`
    DELETE FROM collaborative_docs
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - INTERVAL '${sql.raw(String(RECOVERY_WINDOW_DAYS))} days'
    RETURNING id
  `)
  const count = Array.isArray(result) ? result.length : 0
  if (count > 0) {
    logger.info("purged deleted collaborative docs", { count, windowDays: RECOVERY_WINDOW_DAYS })
  }
}
