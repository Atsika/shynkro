import * as Y from "yjs"
import type { StateDb } from "../state/stateDb"
import { log } from "../logger"

/**
 * Compaction threshold: once a doc accumulates this many incremental updates
 * in `yjs_local_updates`, snapshot the current Y.Doc state and delete the
 * subsumed updates. Mirrors the server-side `COMPACTION_THRESHOLD` so local
 * and server compaction cadence match.
 */
export const LOCAL_COMPACT_THRESHOLD = 500

/**
 * Hydrate a Y.Doc from local persistence: snapshot first, then every update
 * in id order. Returns the doc with full local state pre-applied; the caller
 * still subscribes to the server, which will Y.applyUpdate-merge the
 * authoritative state. Yjs CRDT semantics guarantee convergence regardless
 * of order.
 */
export interface HydrateResult {
  yDoc: Y.Doc
  /**
   * True when the caller should treat the hydrated state as "meaningful" —
   * either a snapshot or at least one update existed in SQLite. Used to
   * decide whether to project the Y.Doc onto the editor before the server
   * replies, and to seed `hasReceivedState` on background entries so the
   * first external disk-edit does not drop on the floor.
   */
  hasLocalState: boolean
}

export function hydrateFromLocal(stateDb: StateDb, docId: string): HydrateResult {
  const yDoc = new Y.Doc()
  const snapshot = stateDb.loadYjsSnapshot(docId)
  if (snapshot) {
    Y.applyUpdate(yDoc, snapshot, "local-restore")
  }
  const updates = stateDb.loadYjsUpdates(docId)
  for (const u of updates) {
    Y.applyUpdate(yDoc, u.bytes, u.origin === "remote" ? "remote" : "local-restore")
  }
  const hasLocalState = !!snapshot || updates.length > 0
  if (hasLocalState) {
    log.appendLine(`[yjsBridge] hydrated ${docId}: snapshot=${!!snapshot} updates=${updates.length}`)
  }
  return { yDoc, hasLocalState }
}

/**
 * If the doc has accumulated more than LOCAL_COMPACT_THRESHOLD incremental
 * updates, replace them with a single snapshot of the current state. Same
 * shape as the server's `maybeCompact`.
 */
export function maybeCompact(stateDb: StateDb, docId: string, yDoc: Y.Doc): void {
  const count = stateDb.yjsUpdateCount(docId)
  if (count < LOCAL_COMPACT_THRESHOLD) return
  try {
    const snapshot = Y.encodeStateAsUpdate(yDoc)
    // Find the highest update id we're collapsing — anything appended after
    // this call (concurrent local edit during snapshot) stays in place.
    const updates = stateDb.loadYjsUpdates(docId)
    if (updates.length === 0) return
    const highestId = updates[updates.length - 1].id
    stateDb.replaceYjsSnapshot(docId, snapshot, highestId)
    log.appendLine(`[yjsBridge] compacted ${docId}: ${count} updates → snapshot ${snapshot.length} bytes`)
  } catch (err) {
    log.appendLine(`[yjsBridge] compaction failed for ${docId}: ${err}`)
  }
}
