import { sql } from "drizzle-orm"
import { db } from "../db/index.js"

/**
 * Purge `recent_op_ids` rows older than the idempotency TTL. The window needs
 * to be long enough to cover a reasonable client-offline period before a replay
 * (so the replay still benefits from dedup) but short enough that the table
 * stays small. 24 hours balances both.
 */
const TTL_HOURS = 24

export async function purgeRecentOpIds(): Promise<void> {
  await db.execute(sql`
    DELETE FROM recent_op_ids
    WHERE created_at < NOW() - INTERVAL '${sql.raw(String(TTL_HOURS))} hours'
  `)
}
