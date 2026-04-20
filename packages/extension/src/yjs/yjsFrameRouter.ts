import * as path from "path"
import * as Y from "yjs"
import { WS_BINARY_YJS_UPDATE, WS_BINARY_YJS_STATE, WS_BINARY_AWARENESS } from "@shynkro/shared"
import type { CursorPayload } from "@shynkro/shared"
import type { WsManager } from "../ws/wsManager"
import type { FileWatcher } from "../sync/fileWatcher"
import type { StateDb } from "../state/stateDb"
import type { AwarenessController } from "./awarenessController"
import type { TextSyncEngine } from "./textSyncEngine"
import type { BackgroundEntry, DocRegistry } from "./docRegistry"
import { buildBinaryFrame, buildYjsUpdateFrame, generateClientUpdateId } from "./yjsFrames"
import { maybeCompact } from "./yjsPersistence"
import { encodeTextForDisk, defaultEol } from "../text/textNormalize"
import { atomicWriteFileSync } from "../text/atomicWrite"
import { log } from "../logger"

/**
 * Routes incoming WS binary frames (Yjs state, Yjs update, awareness) into
 * the right Y.Doc, schedules background-doc writes to disk after server
 * updates, and produces the per-doc Y.Doc update handler that ships local
 * edits over the wire.
 */
export class YjsFrameRouter {
  constructor(
    private readonly registry: DocRegistry,
    private readonly awareness: AwarenessController,
    private readonly textSync: TextSyncEngine,
    private readonly wsManager: WsManager,
    private readonly fileWatcher: FileWatcher,
    private readonly stateDb: StateDb,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Factory for the `yDoc.on("update")` handler. Every mount site (openDoc,
   * subscribeBackground, handleDocClose → background) shares the same policy:
   * persist local + remote updates, send locals over the wire, and nudge the
   * compactor.
   *
   * Local rows are NEVER marked acked here — the server sends a
   * `yjsUpdateAck` JSON message after `persistUpdate()` commits, which is
   * the only signal that proves durability. See {@link handleAck}.
   */
  createUpdateHandler(docId: string, yDoc: Y.Doc): (update: Uint8Array, origin: unknown) => void {
    return (update, origin) => {
      if (origin === "local-restore") return
      const entry = this.registry.getDoc(docId)
      // Recovery mode: the file was remotely deleted, recovery-copy write
      // failed, and the user chose to keep the in-memory buffer. Do not
      // persist or ship anything until the user explicitly exits recovery.
      if (entry?.recoveryMode) return
      const isLocal = origin !== "remote"
      if (isLocal) {
        const clientUpdateId = generateClientUpdateId()
        this.stateDb.appendYjsUpdate(docId, update, "local", false, clientUpdateId)
        const frame = buildYjsUpdateFrame(docId, clientUpdateId, update)
        this.wsManager.sendBinary(frame)
        // Ack on persisted-server-commit, not on ws.send success.
      } else {
        this.stateDb.appendYjsUpdate(docId, update, "remote", true)
      }
      maybeCompact(this.stateDb, docId, yDoc)
    }
  }

  /**
   * Server confirmed `persistUpdate()` for our sender-private clientUpdateId.
   * Retire the row and nudge the compactor so the next threshold check can
   * reclaim the now-durable state.
   */
  handleAck(docId: string, clientUpdateId: string): void {
    this.stateDb.markYjsUpdateAckedByClientId(clientUpdateId)
    const entry = this.registry.getDoc(docId)
    if (entry) {
      maybeCompact(this.stateDb, docId, entry.yDoc)
      return
    }
    const bgEntry = this.registry.getBackground(docId)
    if (bgEntry) maybeCompact(this.stateDb, docId, bgEntry.yDoc)
  }

  handleBinaryFrame(frame: { frameType: number; docId: string; data: Uint8Array }): void {
    const entry = this.registry.getDoc(frame.docId)
    if (entry) {
      // Recovery mode: do not merge server state — the user is protecting a
      // local-only buffer that disagrees with the server's authoritative view.
      if (entry.recoveryMode) return
      if (frame.frameType === WS_BINARY_YJS_STATE || frame.frameType === WS_BINARY_YJS_UPDATE) {
        const isInitialState = frame.frameType === WS_BINARY_YJS_STATE
        // Hold the suppression flag across Y.applyUpdate and the editor
        // write-back: a keystroke that lands between Y.applyUpdate and
        // applyDocToEditor would otherwise be overwritten by the stale diff
        // ranges computed against pre-keystroke text.
        entry.applyingRemote++
        try {
          Y.applyUpdate(entry.yDoc, frame.data, "remote")
          if (isInitialState) {
            // Server state arrived: ack any local updates it already absorbed.
            this.trimAckedLocalUpdates(frame.docId, frame.data, entry.yDoc)
            entry.hasReceivedState = true
          }
        } catch (err) {
          entry.applyingRemote--
          throw err
        }
        this.textSync.applyDocToEditor(entry)
          .catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
          .finally(() => { entry.applyingRemote-- })
      } else if (frame.frameType === WS_BINARY_AWARENESS) {
        if (entry.applyingRemote > 0) {
          try {
            const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
            if (payload.userId !== this.awareness.selfUserId) entry.pendingCursor = payload
          } catch {}
          return
        }
        try {
          const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
          if (payload.userId !== this.awareness.selfUserId) {
            this.awareness.applyRemoteCursor(entry.filePath, payload)
            if (this.awareness.isFollowing(payload.userId)) {
              this.awareness.applyFollowNavigation(frame.docId, entry.filePath, payload)
            }
          }
        } catch {}
      }
      return
    }

    const bgEntry = this.registry.getBackground(frame.docId)
    if (bgEntry) {
      if (frame.frameType === WS_BINARY_YJS_STATE || frame.frameType === WS_BINARY_YJS_UPDATE) {
        const isInitialState = frame.frameType === WS_BINARY_YJS_STATE
        const wasReceived = bgEntry.hasReceivedState
        Y.applyUpdate(bgEntry.yDoc, frame.data, "remote")
        if (isInitialState) {
          bgEntry.hasReceivedState = true
          this.trimAckedLocalUpdates(frame.docId, frame.data, bgEntry.yDoc)
        }
        // First-ever state: drain immediately rather than waiting another 300
        // ms tick. Any offline external-edit that raced the reconnect lands
        // to disk as part of the same merge.
        if (isInitialState && !wasReceived) this.flushBackgroundWrite(frame.docId, bgEntry)
        else this.scheduleBackgroundWrite(frame.docId, bgEntry)
      } else if (frame.frameType === WS_BINARY_AWARENESS) {
        if (this.awareness.followedUserId) {
          try {
            const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
            if (this.awareness.isFollowing(payload.userId)) {
              this.awareness.applyFollowNavigation(frame.docId, bgEntry.filePath, payload)
            }
          } catch {}
        }
      }
    }
  }

  /**
   * On receipt of an initial server state frame, ack any local updates the
   * server has already absorbed, so the compactor can reclaim them. Called
   * from both foreground and background paths — identical logic.
   */
  private trimAckedLocalUpdates(docId: string, frameData: Uint8Array, yDoc: Y.Doc): void {
    try {
      const serverProbe = new Y.Doc()
      Y.applyUpdate(serverProbe, frameData, "remote")
      const serverVec = Y.encodeStateVector(serverProbe)
      serverProbe.destroy()
      const unacked = this.stateDb.loadUnackedLocalUpdates(docId)
      for (const u of unacked) {
        const remaining = Y.diffUpdate(u.bytes, serverVec)
        // diffUpdate returns a "header-only" update of length 2 when nothing remains.
        if (remaining.length <= 2) this.stateDb.markYjsUpdateAcked(u.id)
      }
      maybeCompact(this.stateDb, docId, yDoc)
    } catch (err) {
      log.appendLine(`[yjsBridge] state-vector trim failed for ${docId}: ${err}`)
    }
  }

  private scheduleBackgroundWrite(docId: string, entry: BackgroundEntry): void {
    if (entry.writeTimer) clearTimeout(entry.writeTimer)
    entry.writeTimer = setTimeout(() => {
      entry.writeTimer = null
      this.flushBackgroundWrite(docId, entry)
    }, 300)
  }

  /**
   * Write the current Y.Doc content to disk now. Skipped when the doc has
   * not yet received authoritative server state — we refuse to echo pre-sync
   * content that would overwrite a concurrent external edit. Also skipped
   * when the file row has been tombstoned (rename/delete in flight).
   */
  private flushBackgroundWrite(docId: string, entry: BackgroundEntry): void {
    if (!entry.hasReceivedState) return
    const relPath = path.relative(this.workspaceRoot, entry.filePath).replace(/\\/g, "/")
    const row = this.stateDb.getFileByPath(relPath)
    if (!row) {
      log.appendLine(`[yjsBridge] skipping background write for deleted file ${path.basename(entry.filePath)}`)
      this.registry.deleteBackground(docId)
      return
    }
    const lfText = entry.yDoc.getText("content").toString()
    const eol = (row.eolStyle ?? defaultEol()) as "lf" | "crlf"
    const bom = !!row.hasBom
    const encoded = encodeTextForDisk(lfText, eol, bom)
    try {
      this.fileWatcher.addWriteTag(entry.filePath)
      atomicWriteFileSync(entry.filePath, encoded, { encoding: "utf-8" })
    } catch (err) {
      log.appendLine(`[yjsBridge] background write error for ${path.basename(entry.filePath)}: ${err}`)
    }
  }

  /** Called by yjsBridge on WS disconnect: cancel any pending bg writes. */
  cancelPendingBackgroundWrites(): void {
    for (const [, bg] of this.registry.backgroundEntries()) {
      if (bg.writeTimer) {
        clearTimeout(bg.writeTimer)
        bg.writeTimer = null
      }
    }
  }
}
