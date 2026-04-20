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
import { buildBinaryFrame } from "./yjsFrames"
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
   * persist local + remote updates, send locals over the wire, ack on send,
   * and nudge the compactor.
   */
  createUpdateHandler(docId: string, yDoc: Y.Doc): (update: Uint8Array, origin: unknown) => void {
    return (update, origin) => {
      if (origin === "local-restore") return
      const isLocal = origin !== "remote"
      const acked = !isLocal
      const id = this.stateDb.appendYjsUpdate(docId, update, isLocal ? "local" : "remote", acked)
      if (isLocal) {
        const frame = buildBinaryFrame(WS_BINARY_YJS_UPDATE, docId, update)
        const sent = this.wsManager.sendBinary(frame)
        if (sent) this.stateDb.markYjsUpdateAcked(id)
      }
      maybeCompact(this.stateDb, docId, yDoc)
    }
  }

  handleBinaryFrame(frame: { frameType: number; docId: string; data: Uint8Array }): void {
    const entry = this.registry.getDoc(frame.docId)
    if (entry) {
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
            this.awareness.applyRemoteCursor(entry.filePath, entry.editor, payload)
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
        Y.applyUpdate(bgEntry.yDoc, frame.data, "remote")
        if (isInitialState) {
          bgEntry.hasReceivedState = true
          this.trimAckedLocalUpdates(frame.docId, frame.data, bgEntry.yDoc)
        }
        this.scheduleBackgroundWrite(frame.docId, bgEntry)
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
    }, 300)
  }
}
