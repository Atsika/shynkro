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

export class ChangeReconciler {
  private pollTimer: NodeJS.Timeout | null = null
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly workspaceId: WorkspaceId,
    private readonly workspaceRoot: string,
    private readonly stateDb: StateDb,
    private readonly restClient: RestClient,
    private readonly fileWatcher: FileWatcher,
    private readonly binarySync: BinarySync
  ) {}

  async reconcile(): Promise<void> {
    const localRev = this.stateDb.getRevision(this.workspaceId)
    let currentRevision: number
    let changes: Awaited<ReturnType<typeof this.restClient.getChanges>>["changes"]
    try {
      ;({ currentRevision, changes } = await this.restClient.getChanges(this.workspaceId, localRev))
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        // Change log pruned — full resync from revision 0
        ;({ currentRevision, changes } = await this.restClient.getChanges(this.workspaceId, 0))
      } else {
        throw err
      }
    }

    for (const change of changes) {
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

    this.stateDb.setRevision(this.workspaceId, currentRevision)
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
      this.reconcile().catch(() => {})
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
      this.stateDb.setRevision(this.workspaceId, msg.revision)
      return
    }

    // Skip files that already exist on disk — Yjs handles content sync for text files
    if (fs.existsSync(localPath)) {
      this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind, msg.docId ?? undefined)
      this.stateDb.setRevision(this.workspaceId, msg.revision)
      if (msg.kind === "text" && msg.docId) this._onTextFileRegistered.fire(localPath)
      return
    }

    const dir = path.dirname(localPath)
    fs.mkdirSync(dir, { recursive: true })

    if (msg.kind === "text") {
      try {
        const content = await this.restClient.getFileContent(this.workspaceId, msg.fileId)
        this.fileWatcher.addWriteTag(localPath)
        fs.writeFileSync(localPath, content, "utf-8")
        this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind, msg.docId ?? undefined)
        this.stateDb.setRevision(this.workspaceId, msg.revision)
        log.appendLine(`[reconciler] created ${msg.path}`)
        this._onTextFileRegistered.fire(localPath)
      } catch (err) {
        log.appendLine(`[reconciler] applyCreated error for ${msg.path}: ${err}`)
      }
    } else if (msg.kind === "binary") {
      // Register in stateDb first so binaryUpdated can find it even if download fails
      this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind)
      this.stateDb.setRevision(this.workspaceId, msg.revision)
      try {
        await this.binarySync.download(msg.fileId, localPath, this.workspaceId)
      } catch (err) {
        log.appendLine(`[reconciler] binarySync.download error for ${msg.path}: ${err}`)
      }
    } else {
      // folder
      fs.mkdirSync(localPath, { recursive: true })
      this.stateDb.upsertFile(msg.fileId, msg.path, msg.kind)
      this.stateDb.setRevision(this.workspaceId, msg.revision)
    }
  }

  private async applyRenamed(msg: FileRenamedMessage): Promise<void> {
    const oldLocal = safeJoin(this.workspaceRoot, msg.oldPath)
    const newLocal = safeJoin(this.workspaceRoot, msg.path)
    if (!oldLocal || !newLocal) { log.appendLine(`[reconciler] path traversal blocked: rename ${msg.oldPath} -> ${msg.path}`); return }
    try {
      fs.mkdirSync(path.dirname(newLocal), { recursive: true })
      this.fileWatcher.addWriteTag(newLocal)
      this.fileWatcher.addWriteTag(oldLocal)
      fs.renameSync(oldLocal, newLocal)
      this.stateDb.renameFile(msg.fileId, msg.path)
      this.stateDb.setRevision(this.workspaceId, msg.revision)
    } catch (err) {
      log.appendLine(`[reconciler] applyRenamed error: ${err}`)
    }
  }

  private async applyDeleted(msg: FileDeletedMessage): Promise<void> {
    const localPath = safeJoin(this.workspaceRoot, msg.path)
    if (!localPath) { log.appendLine(`[reconciler] path traversal blocked: ${msg.path}`); return }
    this.fileWatcher.addWriteTag(localPath)
    try {
      // rmSync handles files, directories (recursive), and is a no-op when force:true + path missing
      fs.rmSync(localPath, { recursive: true, force: true })
    } catch (err) {
      log.appendLine(`[reconciler] applyDeleted error for ${msg.path}: ${err}`)
    }
    // Hard-delete: server has confirmed the deletion, so the tombstone is no longer needed.
    this.stateDb.purgeFile(msg.fileId)
    this.stateDb.setRevision(this.workspaceId, msg.revision)
  }

  private async applyBinaryUpdated(msg: BinaryUpdatedMessage): Promise<void> {
    const row = this.stateDb.getFileById(msg.fileId)
    if (!row) return
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
          this.stateDb.setRevision(this.workspaceId, msg.revision)
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
        } else {
          await this.binarySync.download(msg.fileId as FileId, localPath, this.workspaceId)
        }
      } else {
        await this.binarySync.download(msg.fileId as FileId, localPath, this.workspaceId)
      }

      this.stateDb.setRevision(this.workspaceId, msg.revision)
    } catch (err) {
      log.appendLine(`[reconciler] applyBinaryUpdated error for ${row.path}: ${err}`)
    }
  }

  private readonly _onTextFileRegistered = new vscode.EventEmitter<string>()
  readonly onTextFileRegistered = this._onTextFileRegistered.event

  dispose(): void {
    this.stopPolling()
    this.disposables.forEach((d) => d.dispose())
    this._onTextFileRegistered.dispose()
  }
}
