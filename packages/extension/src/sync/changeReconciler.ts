import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { log } from "../logger"
import { safeJoin } from "../pathUtils"
import type {
  FileId,
  WorkspaceId,
  FileCreatedMessage,
  FileRenamedMessage,
  FileDeletedMessage,
  BinaryUpdatedMessage,
} from "@shynkro/shared"
import { CHANGE_POLL_INTERVAL_MS } from "../constants"
import type { RestClient } from "../api/restClient"
import { ApiError } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { FileWatcher } from "./fileWatcher"
import type { BinarySync } from "../binary/binarySync"
import { encodeTextForDisk, defaultEol } from "../text/textNormalize"
import { atomicWriteFileSync } from "../text/atomicWrite"

export class ChangeReconciler {
  private pollTimer: NodeJS.Timeout | null = null
  private readonly disposables: vscode.Disposable[] = []
  /** E4: Guard against concurrent reconcile runs */
  private reconciling = false
  /**
   * M11: While true, apply* methods skip per-change setRevision so the page's
   * end-of-loop write in `_reconcile` is the sole advance. WS single-event
   * path leaves this false and persists each event's revision immediately.
   */
  private inReconcileLoop = false
  /**
   * Paths that were "untracked" by the local user — the server will broadcast
   * fileDeleted for these, but we must NOT rm the local file. The set is
   * consumed (entry removed) when applyDeleted fires for that path.
   */
  private readonly untrackedPaths = new Set<string>()

  constructor(
    private readonly workspaceId: WorkspaceId,
    private readonly workspaceRoot: string,
    private readonly stateDb: StateDb,
    private readonly restClient: RestClient,
    private readonly fileWatcher: FileWatcher,
    private readonly binarySync: BinarySync
  ) {}

  /**
   * Mark a path as "untracked locally" so the upcoming fileDeleted broadcast
   * from the server skips the local `fs.rmSync`. The entry is consumed once.
   */
  markUntracked(relPath: string): void {
    this.untrackedPaths.add(relPath)
  }

  async reconcile(): Promise<void> {
    // E4: Prevent concurrent reconcile runs from polling + manual overlap
    if (this.reconciling) return
    this.reconciling = true
    try { await this._reconcile() } finally { this.reconciling = false }
  }

  private async _reconcile(): Promise<void> {
    // Stream the change log in pages so a client reconnecting after a long
    // offline stretch never loads millions of rows in one response. The first
    // page carries `currentRevision` (frozen at fetch time); subsequent pages
    // carry the same value so we only advance `stateDb.setRevision` once the
    // whole stream is drained.
    const localRev = this.stateDb.getRevision(this.workspaceId)
    let since = localRev
    let offset = 0
    let finalRevision: number | null = null
    const LIMIT = 1000

    const fetchPage = async (sinceRev: number, off: number): Promise<Awaited<ReturnType<typeof this.restClient.getChanges>>> => {
      try {
        return await this.restClient.getChanges(this.workspaceId, sinceRev, { limit: LIMIT, offset: off })
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) {
          // Change log pruned — full resync from revision 0
          return await this.restClient.getChanges(this.workspaceId, 0, { limit: LIMIT, offset: 0 })
        }
        throw err
      }
    }

    this.inReconcileLoop = true
    try {
      while (true) {
        const page = await fetchPage(since, offset)
        finalRevision = page.currentRevision

        for (const change of page.changes) {
          switch (change.type) {
            case "fileCreated":
              await this.applyCreated(change as unknown as FileCreatedMessage)
              break
            case "fileRenamed":
              await this.applyRenamed(change as unknown as FileRenamedMessage)
              break
            case "fileDeleted":
              await this.applyDeleted(change as unknown as FileDeletedMessage)
              break
            case "binaryUpdated":
              await this.applyBinaryUpdated(change as unknown as BinaryUpdatedMessage)
              break
          }
        }

        if (!page.hasMore || page.nextOffset === null || page.nextOffset === undefined) break
        offset = page.nextOffset
        // since stays the same across pages — pagination is anchored to the
        // original query. If the server gets new changes mid-drain, they'll
        // arrive on the next reconcile tick via startPolling.
      }
    } finally {
      this.inReconcileLoop = false
    }

    if (finalRevision !== null) {
      this.stateDb.setRevision(this.workspaceId, finalRevision)
    }
  }

  /** M11: setRevision that no-ops while we're draining a reconcile page. */
  private setRevisionIfLive(msg: { revision: number }): void {
    if (this.inReconcileLoop) return
    this.stateDb.setRevision(this.workspaceId, msg.revision)
  }

  wireWsEvents(onServerMessage: vscode.Event<import("@shynkro/shared").ServerMessage>): void {
    this.disposables.push(
      onServerMessage((msg) => {
        switch (msg.type) {
          case "fileCreated":    this.applyCreated(msg).catch((e) => log.appendLine(`[reconciler] ws fileCreated error: ${e}`)); break
          case "fileRenamed":   this.applyRenamed(msg).catch((e) => log.appendLine(`[reconciler] ws fileRenamed error: ${e}`)); break
          case "fileDeleted":   this.applyDeleted(msg).catch((e) => log.appendLine(`[reconciler] ws fileDeleted error: ${e}`)); break
          case "binaryUpdated": this.applyBinaryUpdated(msg).catch((e) => log.appendLine(`[reconciler] ws binaryUpdated error: ${e}`)); break
        }
      })
    )
  }

  startPolling(): void {
    this.pollTimer = setInterval(() => {
      // M1: Log reconcile errors instead of silently swallowing
      this.reconcile().catch((err) => log.appendLine(`[reconciler] poll reconcile error: ${err}`))
    }, CHANGE_POLL_INTERVAL_MS)
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
  }

  private async applyCreated(msg: FileCreatedMessage): Promise<void> {
    const localPath = safeJoin(this.workspaceRoot, msg.path)
    if (!localPath) { log.appendLine(`[reconciler] path traversal blocked: ${msg.path}`); return }

    // If this path was intentionally deleted by the local user, re-delete it from the
    // server instead of restoring it. This handles server restarts that replay file
    // history and re-surface files the user already deleted.
    if (this.stateDb.isPathDeleted(msg.path)) {
      log.appendLine(`[reconciler] re-deleting tombstoned path from server: ${msg.path}`)
      this.restClient.deleteFile(this.workspaceId, msg.fileId as FileId).catch((err) => {
        log.appendLine(`[reconciler] re-delete error for ${msg.path}: ${err}`)
      })
      this.setRevisionIfLive(msg)
      return
    }

    // Skip files that already exist on disk — Yjs handles content sync for text files
    if (fs.existsSync(localPath)) {
      this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind, msg.docId ?? undefined)
      this.setRevisionIfLive(msg)
      if (msg.kind === "text" && msg.docId) this._onTextFileRegistered.fire(localPath)
      this._onFileTracked.fire(localPath)
      return
    }

    const dir = path.dirname(localPath)
    fs.mkdirSync(dir, { recursive: true })

    if (msg.kind === "text") {
      try {
        // Server holds canonical LF / no-BOM text. Reconstruct disk format from
        // the per-file metadata recorded by whichever client first ingested it
        // (or fall back to the OS default for files seeded from outside this client).
        const content = await this.restClient.getFileContent(this.workspaceId, msg.fileId)
        this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind, msg.docId ?? undefined)
        // Mode bits broadcast over the WS message — capture before write so chmod
        // below sees them. For text files, mode flows only through the create event.
        if (msg.mode !== null && msg.mode !== undefined) {
          this.stateDb.setFileMode(msg.fileId, msg.mode & 0o777)
        }
        const row = this.stateDb.getFileById(msg.fileId)
        const eol = (row?.eolStyle ?? defaultEol()) as "lf" | "crlf"
        const bom = !!row?.hasBom
        const encoded = encodeTextForDisk(content, eol, bom)
        this.fileWatcher.addWriteTag(localPath)
        atomicWriteFileSync(localPath, encoded, { encoding: "utf-8" })
        // Persist the format we just used so subsequent reads stay consistent.
        if (row && row.eolStyle === null) {
          this.stateDb.setTextFormat(msg.fileId, eol, bom)
        }
        // Apply mode bits to the freshly-written file (POSIX hosts only).
        if (process.platform !== "win32" && row?.mode !== null && row?.mode !== undefined) {
          try {
            fs.chmodSync(localPath, row.mode)
          } catch (err) {
            log.appendLine(`[reconciler] chmod ${row.mode.toString(8)} failed for ${localPath}: ${err}`)
          }
        }
        this.setRevisionIfLive(msg)
        log.appendLine(`[reconciler] created ${msg.path}`)
        this._onTextFileRegistered.fire(localPath)
        this._onFileTracked.fire(localPath)
      } catch (err) {
        log.appendLine(`[reconciler] applyCreated error for ${msg.path}: ${err}`)
      }
    } else if (msg.kind === "binary") {
      // Register in stateDb first so binaryUpdated can find it even if download fails
      this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind)
      // Pre-seed mode if the create message carried it — binarySync.download will
      // overwrite it with whatever the blob endpoint returns, but this keeps the
      // record consistent in case the blob fetch fails.
      if (msg.mode !== null && msg.mode !== undefined) {
        this.stateDb.setFileMode(msg.fileId, msg.mode & 0o777)
      }
      this.setRevisionIfLive(msg)
      this._onFileTracked.fire(localPath)
      try {
        await this.binarySync.download(msg.fileId, localPath, this.workspaceId)
      } catch (err) {
        log.appendLine(`[reconciler] binarySync.download error for ${msg.path}: ${err}`)
      }
    } else {
      // folder
      fs.mkdirSync(localPath, { recursive: true })
      this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind)
      this.setRevisionIfLive(msg)
      this._onFileTracked.fire(localPath)
    }
  }

  private async applyRenamed(msg: FileRenamedMessage): Promise<void> {
    const oldLocal = safeJoin(this.workspaceRoot, msg.oldPath)
    const newLocal = safeJoin(this.workspaceRoot, msg.path)
    if (!oldLocal || !newLocal) { log.appendLine(`[reconciler] path traversal blocked: rename ${msg.oldPath} -> ${msg.path}`); return }
    try {
      fs.mkdirSync(path.dirname(newLocal), { recursive: true })
      // Only rename on disk if we still have the source and don't already have the
      // target — otherwise this is the echo of our own local rename, where the
      // filesystem move was performed by VS Code before this WS message arrived.
      const oldExists = fs.existsSync(oldLocal)
      const newExists = fs.existsSync(newLocal)
      if (oldExists && !newExists) {
        this.fileWatcher.addWriteTag(newLocal)
        this.fileWatcher.addWriteTag(oldLocal)
        fs.renameSync(oldLocal, newLocal)
      }
      // stateDb.renameFile is idempotent — safe to call whether or not we just moved.
      this.stateDb.renameFile(msg.fileId, msg.path)
      this.setRevisionIfLive(msg)
      this._onFileTracked.fire(newLocal)
      this._onFileTracked.fire(oldLocal)
    } catch (err) {
      log.appendLine(`[reconciler] applyRenamed error: ${err}`)
    }
  }

  private async applyDeleted(msg: FileDeletedMessage): Promise<void> {
    const localPath = safeJoin(this.workspaceRoot, msg.path)
    if (!localPath) { log.appendLine(`[reconciler] path traversal blocked: ${msg.path}`); return }

    // If this path was "untracked" by the local user, the server broadcast
    // is the echo of our own delete-from-workspace call. Skip the local rm
    // so the user's file stays on disk as promised.
    const isUntrack = this.untrackedPaths.has(msg.path)
    if (isUntrack) {
      this.untrackedPaths.delete(msg.path)
      log.appendLine(`[reconciler] applyDeleted: skipping local rm for untracked path ${msg.path}`)
    }

    this.fileWatcher.addWriteTag(localPath)
    // Signal the Yjs bridge so any open editor for this file gets torn down
    // (closes the tab, prompts for recovery if dirty, unsubscribes the doc).
    // Fire before removing the file so the bridge's lookup by path still works.
    this._onRemoteFileDeleted.fire({ absPath: localPath })

    if (!isUntrack) {
      try {
        // rmSync handles files, directories (recursive), and is a no-op when force:true + path missing
        fs.rmSync(localPath, { recursive: true, force: true })
      } catch (err) {
        log.appendLine(`[reconciler] applyDeleted error for ${msg.path}: ${err}`)
      }
    }

    // Hard-delete: server has confirmed the deletion, so the tombstone is no longer needed.
    this.stateDb.purgeFile(msg.fileId)
    this.setRevisionIfLive(msg)
  }

  /** Fires when a file was deleted by another collaborator (via WS or poll). */
  private readonly _onRemoteFileDeleted = new vscode.EventEmitter<{ absPath: string }>()
  readonly onRemoteFileDeleted = this._onRemoteFileDeleted.event

  private async applyBinaryUpdated(msg: BinaryUpdatedMessage): Promise<void> {
    const row = this.stateDb.getFileById(msg.fileId)
    if (!row) return
    // Refresh stored mode bits regardless of whether content changed — covers the
    // case where a peer ran `chmod +x` and re-uploaded the same content.
    if (msg.mode !== null && msg.mode !== undefined) {
      this.stateDb.setFileMode(msg.fileId, msg.mode & 0o777)
    }
    if (row.binaryHash === msg.hash) return // already have it

    const localPath = safeJoin(this.workspaceRoot, row.path)
    if (!localPath) { log.appendLine(`[reconciler] path traversal blocked: ${row.path}`); return }
    try {
      // If local file was also modified since last sync, ask the user which version to keep.
      let localHash: string | undefined
      let localChanged = false
      if (row.binaryHash && fs.existsSync(localPath)) {
        localHash = await this.binarySync.computeHash(localPath)
        localChanged = localHash !== row.binaryHash
      }

      if (localChanged) {
        // If local file already matches the server hash, no real conflict
        // (e.g. both sides regenerated the same PDF from synced source files)
        if (localHash === msg.hash) {
          this.stateDb.updateBinaryHash(msg.fileId, msg.hash)
          this.setRevisionIfLive(msg)
          return
        }

        const fileName = path.basename(row.path)
        const choice = await vscode.window.showWarningMessage(
          `Shynkro: "${fileName}" was modified both locally and on the server.`,
          "Keep Local",
          "Keep Server"
        )
        if (choice === "Keep Local") {
          await this.binarySync.upload(msg.fileId as FileId, localPath, this.workspaceId)
          // E8: Persist local hash so the next poll doesn't re-download server version
          if (localHash) this.stateDb.updateBinaryHash(msg.fileId, localHash)
        } else {
          await this.binarySync.download(msg.fileId as FileId, localPath, this.workspaceId)
          this.stateDb.updateBinaryHash(msg.fileId, msg.hash)
        }
      } else {
        await this.binarySync.download(msg.fileId as FileId, localPath, this.workspaceId)
        this.stateDb.updateBinaryHash(msg.fileId, msg.hash)
      }

      this.setRevisionIfLive(msg)
    } catch (err) {
      log.appendLine(`[reconciler] applyBinaryUpdated error for ${row.path}: ${err}`)
    }
  }

  private readonly _onTextFileRegistered = new vscode.EventEmitter<string>()
  readonly onTextFileRegistered = this._onTextFileRegistered.event

  /** Fires when any file (text, binary, or folder) is added to stateDb by the reconciler. */
  private readonly _onFileTracked = new vscode.EventEmitter<string>()
  readonly onFileTracked = this._onFileTracked.event

  dispose(): void {
    this.stopPolling()
    this.disposables.forEach((d) => d.dispose())
    this._onTextFileRegistered.dispose()
    this._onFileTracked.dispose()
    this._onRemoteFileDeleted.dispose()
  }
}
