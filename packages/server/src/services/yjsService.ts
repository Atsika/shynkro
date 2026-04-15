import { createHash } from "node:crypto"
import * as Y from "yjs"
import { eq, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { collaborativeDocs, yjsUpdates } from "../db/schema.js"
import { logger } from "../lib/logger.js"

const COMPACTION_THRESHOLD = 500

/**
 * Thrown when a Yjs document can no longer be trusted — either the stored snapshot
 * hash does not match the snapshot bytes, or applying the snapshot as a Yjs update
 * fails. Signals callers to surface an error to the client instead of silently
 * handing them a fresh empty Y.Doc (which, if edited, would overwrite real content
 * on the next `persistUpdate` or `maybeCompact`).
 */
export class DocCorruptedError extends Error {
  readonly code = "DOC_CORRUPTED"
  constructor(public readonly docId: string, cause?: unknown) {
    super(`Collaborative document ${docId} is corrupted and cannot be loaded; restore from backup before editing`)
    if (cause !== undefined) {
      // Keep the original Error stack/context so ops can diagnose without server-log archaeology.
      ;(this as { cause?: unknown }).cause = cause
    }
    this.name = "DocCorruptedError"
  }
}

/**
 * Thrown when a caller tries to load a doc that has been soft-deleted (the
 * owning file was deleted but the purge job hasn't run yet). The file is
 * recoverable by clearing deleted_at, but in the meantime the doc is not
 * available for editing or reading. Surfaces as a 410 / DOC_DELETED.
 */
export class DocDeletedError extends Error {
  readonly code = "DOC_DELETED"
  constructor(public readonly docId: string) {
    super(`Collaborative document ${docId} has been deleted`)
    this.name = "DocDeletedError"
  }
}

function sha256Hex(data: Uint8Array | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

/**
 * Persist the corruption flag and log a loud error. Separate helper so every
 * code path that detects corruption surfaces it the same way.
 */
async function markCorrupted(docId: string, reason: string, cause?: unknown): Promise<void> {
  logger.error("doc corrupted — halting writes", { docId, reason, cause: cause !== undefined ? String(cause) : undefined })
  try {
    await db
      .update(collaborativeDocs)
      .set({ corrupted: true })
      .where(eq(collaborativeDocs.id, docId))
  } catch (err) {
    // If we can't even write the flag, the DB is in worse shape than the doc.
    // Log loudly; the throw that follows will still abort the current operation.
    logger.error("failed to persist corrupted flag", { docId, err: String(err) })
  }
}

export async function loadDoc(docId: string): Promise<Y.Doc> {
  const [docRow] = await db
    .select()
    .from(collaborativeDocs)
    .where(eq(collaborativeDocs.id, docId))
    .limit(1)

  if (!docRow) throw new Error(`Doc not found: ${docId}`)
  if (docRow.corrupted) throw new DocCorruptedError(docId)
  if (docRow.deletedAt) throw new DocDeletedError(docId)

  const doc = new Y.Doc()

  // Apply snapshot first, with integrity verification.
  if (docRow.snapshot) {
    // snapshotHash is populated alongside the snapshot itself by maybeCompact.
    // Docs compacted before B1 will have a non-null snapshot with a null hash;
    // tolerate that by skipping the hash check but still trusting applyUpdate
    // as the final gate. On next compaction, the hash is written and future
    // loads are fully protected.
    if (docRow.snapshotHash !== null) {
      const actual = sha256Hex(docRow.snapshot)
      if (actual !== docRow.snapshotHash) {
        await markCorrupted(docId, "snapshot hash mismatch", { expected: docRow.snapshotHash, actual })
        throw new DocCorruptedError(docId)
      }
    }
    try {
      Y.applyUpdate(doc, docRow.snapshot)
    } catch (err) {
      await markCorrupted(docId, "snapshot apply failed", err)
      throw new DocCorruptedError(docId, err)
    }
  }

  // Replay updates since snapshot. A single corrupt update is tolerated —
  // Yjs is resilient to missing updates (the CRDT converges regardless) and
  // the remaining updates may carry recoverable state. Only the snapshot is
  // considered load-bearing for halt-on-corrupt.
  const updates = await db
    .select()
    .from(yjsUpdates)
    .where(eq(yjsUpdates.docId, docId))
    .orderBy(yjsUpdates.id)

  for (const update of updates) {
    try {
      Y.applyUpdate(doc, update.data)
    } catch (err) {
      logger.error("yjs update corrupt (skipped)", { docId, updateId: update.id, err: String(err) })
    }
  }

  return doc
}

export async function persistUpdate(docId: string, update: Uint8Array): Promise<void> {
  // Refuse writes on docs that have already been flagged corrupted — prevents an
  // edit made against a "recovered" empty doc from becoming the new source of truth.
  // Also refuse writes on soft-deleted docs so a late-arriving client can't
  // accidentally un-delete a file by continuing to push updates.
  const [docRow] = await db
    .select({ corrupted: collaborativeDocs.corrupted, deletedAt: collaborativeDocs.deletedAt })
    .from(collaborativeDocs)
    .where(eq(collaborativeDocs.id, docId))
    .limit(1)
  if (!docRow) throw new Error(`Doc not found: ${docId}`)
  if (docRow.corrupted) throw new DocCorruptedError(docId)
  if (docRow.deletedAt) throw new DocDeletedError(docId)

  await db.insert(yjsUpdates).values({
    docId,
    data: Buffer.from(update),
  })

  await db.execute(
    sql`UPDATE collaborative_docs SET update_count = update_count + 1 WHERE id = ${docId}`
  )
}

export async function maybeCompact(docId: string): Promise<void> {
  // CAS: only proceed if update_count is still above threshold (prevents double compaction)
  const [claimed] = await db.execute<{ id: string }>(
    sql`UPDATE collaborative_docs SET update_count = 0
        WHERE id = ${docId} AND update_count >= ${COMPACTION_THRESHOLD}
        RETURNING id`
  )
  if (!claimed) return

  try {
    const doc = await loadDoc(docId)
    const snapshotBytes = Y.encodeStateAsUpdate(doc)
    const snapshot = Buffer.from(snapshotBytes)
    const snapshotHash = sha256Hex(snapshotBytes)

    await db.transaction(async (tx) => {
      await tx
        .update(collaborativeDocs)
        .set({ snapshot, snapshotHash, snapshotAt: new Date() })
        .where(eq(collaborativeDocs.id, docId))
      await tx.delete(yjsUpdates).where(eq(yjsUpdates.docId, docId))
    })
  } catch (err) {
    // A DocCorruptedError from loadDoc is already logged and persisted by markCorrupted.
    // Do NOT clobber an already-corrupted doc with an empty snapshot — just bail.
    if (err instanceof DocCorruptedError) {
      logger.error("compaction skipped — doc already corrupted", { docId })
      return
    }
    logger.error("compaction failed", { docId, err: String(err) })
  }
}

export async function initDocWithText(docId: string, text: string): Promise<void> {
  if (!text && text !== "") return
  const doc = new Y.Doc()
  if (text.length > 0) {
    doc.getText("content").insert(0, text)
  }
  const update = Y.encodeStateAsUpdate(doc)
  await persistUpdate(docId, update)
}

/**
 * Prepare the Yjs update buffer for a doc without persisting.
 * Used inside transactions to avoid the race where a doc row exists but has no content.
 */
export function prepareDocUpdate(text: string): Buffer {
  const doc = new Y.Doc()
  if (text.length > 0) {
    doc.getText("content").insert(0, text)
  }
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

export async function getPlainText(docId: string): Promise<string> {
  const doc = await loadDoc(docId)
  return doc.getText("content").toString()
}

export async function encodeDocState(docId: string): Promise<Uint8Array> {
  const doc = await loadDoc(docId)
  return Y.encodeStateAsUpdate(doc)
}

/**
 * Atomically replace all Yjs state for a document with a fresh Y.Doc
 * initialised from `text`. Used by conflict resolution to establish a clean,
 * authoritative state that bypasses CRDT merge semantics entirely.
 *
 * Returns the new state binary so the caller can broadcast it over WebSocket.
 */
export async function forceSetDocContent(docId: string, text: string): Promise<Buffer> {
  const [docRow] = await db
    .select({ corrupted: collaborativeDocs.corrupted, deletedAt: collaborativeDocs.deletedAt })
    .from(collaborativeDocs)
    .where(eq(collaborativeDocs.id, docId))
    .limit(1)

  if (!docRow) throw new Error(`Doc not found: ${docId}`)
  if (docRow.corrupted) throw new DocCorruptedError(docId)
  if (docRow.deletedAt) throw new DocDeletedError(docId)

  const freshDoc = new Y.Doc()
  if (text.length > 0) freshDoc.getText("content").insert(0, text)
  const update = Buffer.from(Y.encodeStateAsUpdate(freshDoc))
  freshDoc.destroy()

  await db.transaction(async (tx) => {
    // Clear snapshot and all incremental updates, then insert the single authoritative one
    await tx.update(collaborativeDocs)
      .set({ snapshot: null, snapshotHash: null, snapshotAt: null, updateCount: 1 })
      .where(eq(collaborativeDocs.id, docId))
    await tx.delete(yjsUpdates).where(eq(yjsUpdates.docId, docId))
    await tx.insert(yjsUpdates).values({ docId, data: update })
  })

  return update
}
