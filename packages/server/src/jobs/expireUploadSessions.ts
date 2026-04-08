import { lt } from "drizzle-orm"
import { db } from "../db/index.js"
import { uploadSessions } from "../db/schema.js"
import { logger } from "../lib/logger.js"
import { createStorageBackend } from "../storage/index.js"
import { FilesystemStorageBackend } from "../storage/FilesystemStorageBackend.js"

const storage = createStorageBackend()
const chunkedStorage = storage as unknown as FilesystemStorageBackend

/**
 * Sweep abandoned chunked-upload sessions: any row whose `expires_at` has
 * passed gets deleted from `upload_sessions`, and the matching temp directory
 * (chunks + any half-assembled file) is removed from disk.
 *
 * Idempotent: a partial failure during one run leaves the surviving rows for
 * the next tick. Both DB and FS deletes are best-effort and logged.
 */
export async function expireUploadSessions(): Promise<void> {
  const now = new Date()
  const expired = await db
    .select({ id: uploadSessions.id })
    .from(uploadSessions)
    .where(lt(uploadSessions.expiresAt, now))

  if (expired.length === 0) return

  for (const row of expired) {
    try {
      await chunkedStorage.cleanupSession(row.id)
    } catch (err) {
      logger.error("expireUploadSessions cleanup failed", { sessionId: row.id, err: String(err) })
    }
  }
  await db.delete(uploadSessions).where(lt(uploadSessions.expiresAt, now))

  logger.info("expireUploadSessions swept", { count: expired.length })
}
