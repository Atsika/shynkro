import * as Y from "yjs"
import { eq, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { collaborativeDocs, yjsUpdates } from "../db/schema.js"

const COMPACTION_THRESHOLD = 500

export async function loadDoc(docId: string): Promise<Y.Doc> {
  const [docRow] = await db
    .select()
    .from(collaborativeDocs)
    .where(eq(collaborativeDocs.id, docId))
    .limit(1)

  if (!docRow) throw new Error(`Doc not found: ${docId}`)

  const doc = new Y.Doc()

  // Apply snapshot first
  if (docRow.snapshot) {
    try {
      Y.applyUpdate(doc, docRow.snapshot)
    } catch (err) {
      console.error(`[yjs] Snapshot corrupt for doc ${docId}:`, err)
      // Return empty doc — critical but recoverable
      return new Y.Doc()
    }
  }

  // Replay updates since snapshot
  const updates = await db
    .select()
    .from(yjsUpdates)
    .where(eq(yjsUpdates.docId, docId))
    .orderBy(yjsUpdates.id)

  for (const update of updates) {
    try {
      Y.applyUpdate(doc, update.data)
    } catch (err) {
      console.error(`[yjs] Update ${update.id} corrupt for doc ${docId}:`, err)
    }
  }

  return doc
}

export async function persistUpdate(docId: string, update: Uint8Array): Promise<void> {
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
    const snapshot = Buffer.from(Y.encodeStateAsUpdate(doc))

    await db.transaction(async (tx) => {
      await tx
        .update(collaborativeDocs)
        .set({ snapshot, snapshotAt: new Date() })
        .where(eq(collaborativeDocs.id, docId))
      await tx.delete(yjsUpdates).where(eq(yjsUpdates.docId, docId))
    })
  } catch (err) {
    console.error(`[yjs] Compaction failed for doc ${docId}:`, err)
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
