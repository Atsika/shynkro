import * as fs from "fs"
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
import {
  applyCreated,
  applyRenamed,
  applyDeleted,
  applyBinaryUpdated,
  type ApplierContext,
} from "./changeAppliers"

export class ChangeReconciler implements ApplierContext {
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
  readonly untrackedPaths = new Set<string>()
  /**
   * File IDs we initiated a delete for. Used to skip the disk `rm` when the
   * server echoes `fileDeleted` back to us — otherwise a same-tick rm+create
   * would delete the replacement file right after it was created. The stateDb
   * purge still runs; only the filesystem action is suppressed.
   */
  readonly locallyInitiatedDeletes = new Set<string>()

  constructor(
    readonly workspaceId: WorkspaceId,
    readonly workspaceRoot: string,
    readonly stateDb: StateDb,
    readonly restClient: RestClient,
    readonly fileWatcher: FileWatcher,
    readonly binarySync: BinarySync
  ) {}

  /**
   * Mark a path as "untracked locally" so the upcoming fileDeleted broadcast
   * from the server skips the local `fs.rmSync`. The entry is consumed once.
   */
  markUntracked(relPath: string): void {
    this.untrackedPaths.add(relPath)
  }

  markLocalDelete(fileId: string): void {
    this.locallyInitiatedDeletes.add(fileId)
  }

  async reconcile(): Promise<void> {
    // E4: Prevent concurrent reconcile runs from polling + manual overlap
    if (this.reconciling) return
    this.reconciling = true
    try { await this._reconcile() } finally { this.reconciling = false }
  }

  /**
   * Post-reconnect pass for binary files. Binaries never merge automatically;
   * any local divergence from `syncedBinaryHash` always routes through the
   * conflict picker so the user explicitly decides whether to push their
   * version or discard it in favor of the server's. Nothing hits the server
   * until they pick "Keep mine".
   *
   * Short-circuits only when local already matches the server (no real
   * divergence worth asking about).
   */
  async rescanOfflineBinaries(): Promise<void> {
    const files = this.stateDb.allFiles().filter((f) => f.kind === "binary")
    for (const row of files) {
      const localPath = safeJoin(this.workspaceRoot, row.path)
      if (!localPath || !fs.existsSync(localPath)) continue
      const syncedHash = row.syncedBinaryHash ?? row.binaryHash
      if (!syncedHash) continue
      let localHash: string
      try {
        localHash = await this.binarySync.computeHash(localPath)
      } catch (err) {
        log.appendLine(`[reconciler] rescan hash error for ${row.path}: ${err}`)
        continue
      }
      if (localHash === syncedHash) continue // no offline change

      log.appendLine(`[reconciler] rescan: offline change on ${row.path} (synced=${syncedHash.slice(0, 8)} local=${localHash.slice(0, 8)})`)

      // Probe current server hash so the picker can show the real "theirs"
      // state. On any probe error, default to syncedHash (which means the
      // server either hasn't moved or we can't tell — picker still lets the
      // user decide).
      let serverHash = syncedHash
      try {
        const probe = await this.restClient.probeBlobSize(this.workspaceId, row.fileId as FileId)
        if (probe.hash) serverHash = probe.hash
      } catch (err) {
        log.appendLine(`[reconciler] rescan probe error for ${row.path}: ${err}`)
      }

      // Coincidentally identical — local and server independently landed on
      // the same bytes. No conflict; just mark synced.
      if (serverHash === localHash) {
        this.stateDb.setSyncedBinaryHash(row.fileId, localHash)
        continue
      }

      // Local diverged from server. Let the picker drive the outcome — it
      // will upload (with If-Match) if the user picks "Keep mine", or pull
      // the server version if they pick "Take theirs".
      this._onBinaryConflict.fire({
        fileId: row.fileId,
        workspaceId: this.workspaceId,
        localPath,
        localHash,
        serverHash,
        revision: this.stateDb.getRevision(this.workspaceId),
      })
    }
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
              await applyCreated(this, change as unknown as FileCreatedMessage)
              break
            case "fileRenamed":
              await applyRenamed(this, change as unknown as FileRenamedMessage)
              break
            case "fileDeleted":
              await applyDeleted(this, change as unknown as FileDeletedMessage)
              break
            case "binaryUpdated":
              await applyBinaryUpdated(this, change as unknown as BinaryUpdatedMessage)
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
  setRevisionIfLive(msg: { revision: number }): void {
    if (this.inReconcileLoop) return
    this.stateDb.setRevision(this.workspaceId, msg.revision)
  }

  wireWsEvents(onServerMessage: vscode.Event<import("@shynkro/shared").ServerMessage>): void {
    this.disposables.push(
      onServerMessage((msg) => {
        switch (msg.type) {
          case "fileCreated":    applyCreated(this, msg).catch((e) => log.appendLine(`[reconciler] ws fileCreated error: ${e}`)); break
          case "fileRenamed":   applyRenamed(this, msg).catch((e) => log.appendLine(`[reconciler] ws fileRenamed error: ${e}`)); break
          case "fileDeleted":   applyDeleted(this, msg).catch((e) => log.appendLine(`[reconciler] ws fileDeleted error: ${e}`)); break
          case "binaryUpdated": applyBinaryUpdated(this, msg).catch((e) => log.appendLine(`[reconciler] ws binaryUpdated error: ${e}`)); break
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

  /** Fires when a file was deleted by another collaborator (via WS or poll). */
  private readonly _onRemoteFileDeleted = new vscode.EventEmitter<{ absPath: string }>()
  readonly onRemoteFileDeleted = this._onRemoteFileDeleted.event

  /**
   * Fires after a `binaryUpdated` event has been processed (silently
   * downloaded, conflict requested, or no-op). Carries the new server hash so
   * the binary conflict picker can refresh its UI live when the server-side
   * state moves under an open dialog.
   */
  private readonly _onBinaryReconciled = new vscode.EventEmitter<{ fileId: string; serverHash: string; revision: number }>()
  readonly onBinaryReconciled = this._onBinaryReconciled.event

  /**
   * Fires when applyBinaryUpdated detects a divergence the picker should
   * handle. The picker is wired up at startup and decides whether to show UI.
   */
  private readonly _onBinaryConflict = new vscode.EventEmitter<{
    fileId: string
    workspaceId: WorkspaceId
    localPath: string
    localHash: string
    serverHash: string
    revision: number
  }>()
  readonly onBinaryConflict = this._onBinaryConflict.event

  private readonly _onTextFileRegistered = new vscode.EventEmitter<string>()
  readonly onTextFileRegistered = this._onTextFileRegistered.event

  /** Fires when any file (text, binary, or folder) is added to stateDb by the reconciler. */
  private readonly _onFileTracked = new vscode.EventEmitter<string>()
  readonly onFileTracked = this._onFileTracked.event

  // ApplierContext emit methods — thin wrappers so the appliers don't touch
  // EventEmitter internals.
  emitTextFileRegistered(localPath: string): void { this._onTextFileRegistered.fire(localPath) }
  emitFileTracked(localPath: string): void { this._onFileTracked.fire(localPath) }
  emitRemoteFileDeleted(args: { absPath: string }): void { this._onRemoteFileDeleted.fire(args) }
  emitBinaryReconciled(args: { fileId: string; serverHash: string; revision: number }): void {
    this._onBinaryReconciled.fire(args)
  }
  emitBinaryConflict(args: {
    fileId: string
    workspaceId: WorkspaceId
    localPath: string
    localHash: string
    serverHash: string
    revision: number
  }): void { this._onBinaryConflict.fire(args) }

  dispose(): void {
    this.stopPolling()
    this.disposables.forEach((d) => d.dispose())
    this._onTextFileRegistered.dispose()
    this._onFileTracked.dispose()
    this._onRemoteFileDeleted.dispose()
    this._onBinaryReconciled.dispose()
    this._onBinaryConflict.dispose()
  }
}
