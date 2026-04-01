import { sql } from "drizzle-orm"
import { db } from "../db/index.js"

const KEEP_LAST_REVISIONS = 1000

/**
 * Deletes old workspace_changes rows, keeping only the last N revisions per workspace.
 * Clients whose revision falls below the pruned threshold will receive a 410 Gone
 * and perform a full re-sync.
 */
export async function pruneChangeLogs(): Promise<void> {
  await db.execute(sql`
    DELETE FROM workspace_changes
    WHERE id IN (
      SELECT wc.id
      FROM workspace_changes wc
      JOIN workspaces w ON w.id = wc.workspace_id
      WHERE wc.revision <= w.revision - ${KEEP_LAST_REVISIONS}
    )
  `)
}
