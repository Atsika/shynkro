import { lt, and, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { importSessions } from "../db/schema.js"

export async function expireImportSessions(): Promise<void> {
  await db
    .delete(importSessions)
    .where(
      and(
        lt(importSessions.expiresAt, new Date()),
        eq(importSessions.status, "in_progress")
      )
    )
}
