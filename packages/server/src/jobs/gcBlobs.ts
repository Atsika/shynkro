import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { fileEntries } from "../db/schema.js"
import { logger } from "../lib/logger.js"
import { createStorageBackend } from "../storage/index.js"

const storage = createStorageBackend()

/**
 * Grace period before an unreferenced blob is considered an orphan. Covers the
 * upload-then-DB-insert race window where a blob is on disk but the
 * file_entries row hasn't been inserted yet (or the request failed mid-way).
 *
 * 24 hours is generous — any legitimate upload completes its DB insert in well
 * under that, and the cost of being conservative is just delayed disk reclaim.
 */
const ORPHAN_GRACE_HOURS = 24

/**
 * Sweep the blob storage backend for blobs that have no `file_entries.binary_hash`
 * referencing them and have been on disk for longer than the grace period.
 *
 * Two important properties of this design:
 *
 *   1. Soft-deleted file_entries rows still count as references — they keep
 *      their `binary_hash` populated, so the blob stays alive throughout the
 *      30-day soft-delete recovery window. The blob is only collected once
 *      the file_entries row itself is hard-deleted (which today never happens
 *      automatically; manual cleanup or a future fileEntries purge job will
 *      eventually trigger blob GC).
 *   2. The grace period is a wall-clock check on the blob's mtime, not a
 *      tracked "first orphan seen at" timestamp. Simpler, no extra state, and
 *      handles the upload-then-insert race uniformly.
 *
 * The job is intentionally conservative: errors during deletion are logged
 * but don't abort the sweep, and the GC will retry on the next interval tick.
 */
export async function gcBlobs(): Promise<void> {
  const cutoffMs = Date.now() - ORPHAN_GRACE_HOURS * 60 * 60 * 1000
  let scanned = 0
  let deleted = 0
  let referenced = 0
  let withinGrace = 0
  let errored = 0

  for await (const blob of storage.list()) {
    scanned++

    if (blob.mtimeMs > cutoffMs) {
      withinGrace++
      continue
    }

    // Hash format is enforced by the storage backend (`/^[0-9a-f]{64}$/`), so
    // there's no SQL-injection surface from the parameterized query below.
    const [row] = await db
      .select({ id: fileEntries.id })
      .from(fileEntries)
      .where(eq(fileEntries.binaryHash, blob.hash))
      .limit(1)

    if (row) {
      referenced++
      continue
    }

    try {
      await storage.delete(blob.hash)
      deleted++
    } catch (err) {
      errored++
      logger.error("gcBlobs delete failed", { hash: blob.hash, err: String(err) })
    }
  }

  if (scanned > 0) {
    logger.info("gcBlobs swept", {
      scanned,
      deleted,
      referenced,
      withinGrace,
      errored,
    })
  }
}
