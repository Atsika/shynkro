import * as fs from "fs"
import * as vscode from "vscode"
import * as path from "path"
import type { WorkspaceId } from "@shynkro/shared"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { WsManager } from "../ws/wsManager"
import { classifyFile } from "../workspace/fileClassifier"
import { buildIgnoreMatcher } from "../ignoreUtils"
import { ensureShynkroInGitignore } from "../workspace/gitUtils"
import { log } from "../logger"

export class FileWatcher {
  private watcher: vscode.FileSystemWatcher | null = null
  private readonly writeTags = new Set<string>()
  private readonly disposables: vscode.Disposable[] = []
  private readonly ignoreMatcher: (relPath: string) => boolean

  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceId: WorkspaceId,
    private readonly stateDb: StateDb,
    private readonly restClient: RestClient,
    private readonly wsManager: WsManager
  ) {
    this.ignoreMatcher = buildIgnoreMatcher(workspaceRoot)
  }

  start(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, "**/*")
    )
    this.watcher = watcher

    // Watch for .git creation to auto-update .gitignore
    const gitWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceRoot, ".git"),
      false, true, true  // only onCreate
    )

    this.disposables.push(
      watcher.onDidCreate((uri) => this.handleCreate(uri)),
      watcher.onDidChange((uri) => this.handleChange(uri)),
      watcher.onDidDelete((uri) => this.handleDelete(uri)),
      gitWatcher,
      gitWatcher.onDidCreate(() => {
        log.appendLine("[watcher] .git detected — ensuring .shynkro/ in .gitignore")
        ensureShynkroInGitignore(this.workspaceRoot)
      })
    )
  }

  addWriteTag(absolutePath: string): void {
    this.writeTags.add(absolutePath)
  }

  removeWriteTag(absolutePath: string): void {
    this.writeTags.delete(absolutePath)
  }

  private shouldIgnore(uri: vscode.Uri): boolean {
    const rel = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, "/")
    return this.ignoreMatcher(rel)
  }

  private async handleCreate(uri: vscode.Uri): Promise<void> {
    if (this.shouldIgnore(uri)) return
    const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, "/")
    // Skip files already known (e.g. from import) — avoids 409 on init
    if (this.stateDb.getFileByPath(relPath)) return
    let stat: fs.Stats
    try {
      stat = fs.statSync(uri.fsPath)
    } catch {
      return // path vanished before we could stat it
    }
    const kind = stat.isDirectory() ? "folder" : classifyFile(uri.fsPath)

    if (!this.wsManager.connected) {
      const content = kind === "text" ? fs.readFileSync(uri.fsPath, "utf-8") : undefined
      this.stateDb.enqueuePendingOp({ opType: "create", path: relPath, kind, content })
      log.appendLine(`[watcher] offline — queued create ${relPath}`)
      return
    }

    try {
      const content = kind === "text" ? fs.readFileSync(uri.fsPath, "utf-8") : undefined
      const file = await this.restClient.createFile(this.workspaceId, {
        path: relPath,
        kind,
        content,
      })
      this.stateDb.upsertFile(file.id, relPath, kind, file.docId ?? undefined)
      log.appendLine(`[watcher] created ${relPath} id=${file.id} docId=${file.docId}`)
      if (kind === "text" && file.docId) {
        this._onTextFileRegistered.fire(uri.fsPath)
      } else if (kind === "binary") {
        this._onBinaryChanged.fire({ fileId: file.id as import("@shynkro/shared").FileId, localPath: uri.fsPath })
      }
    } catch (err) {
      log.appendLine(`[watcher] handleCreate error for ${relPath}: ${err}`)
    }
  }

  private readonly _onTextFileRegistered = new vscode.EventEmitter<string>()
  readonly onTextFileRegistered = this._onTextFileRegistered.event

  private async handleChange(uri: vscode.Uri): Promise<void> {
    if (this.shouldIgnore(uri)) return
    if (this.writeTags.has(uri.fsPath)) {
      this.writeTags.delete(uri.fsPath)
      return
    }
    const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, "/")
    const row = this.stateDb.getFileByPath(relPath)
    if (!row) return

    if (row.kind === "binary") {
      // Binary sync is handled by BinarySync via explicit call from changeReconciler
      // Emit a synthetic event for BinarySync to pick up
      this._onBinaryChanged.fire({ fileId: row.fileId as import("@shynkro/shared").FileId, localPath: uri.fsPath })
    } else if (row.kind === "text" && row.docId) {
      this._onTextFileChangedExternally.fire({ fileId: row.fileId as import("@shynkro/shared").FileId, docId: row.docId, filePath: uri.fsPath })
    }
  }

  private readonly _onBinaryChanged = new vscode.EventEmitter<{
    fileId: import("@shynkro/shared").FileId
    localPath: string
  }>()
  readonly onBinaryChanged = this._onBinaryChanged.event

  private readonly _onTextFileChangedExternally = new vscode.EventEmitter<{
    fileId: import("@shynkro/shared").FileId
    docId: string
    filePath: string
  }>()
  readonly onTextFileChangedExternally = this._onTextFileChangedExternally.event

  private async handleDelete(uri: vscode.Uri): Promise<void> {
    if (this.shouldIgnore(uri)) return
    if (this.writeTags.has(uri.fsPath)) {
      this.writeTags.delete(uri.fsPath)
      return
    }
    const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, "/")
    const row = this.stateDb.getFileByPath(relPath)
    if (!row) return

    // Soft-delete: marks the row as deleted (tombstone) but keeps it in file_map so that
    // if the server re-surfaces this file (e.g. after a server restart), applyCreated
    // will re-delete it rather than restoring it locally.
    this.stateDb.deleteFile(row.fileId)

    if (!this.wsManager.connected) {
      this.stateDb.enqueuePendingOp({ opType: "delete", path: relPath, fileId: row.fileId })
      log.appendLine(`[watcher] offline — queued delete ${relPath}`)
      return
    }

    try {
      await this.restClient.deleteFile(this.workspaceId, row.fileId as import("@shynkro/shared").FileId)
    } catch (err) {
      log.appendLine(`[watcher] handleDelete error for ${relPath}: ${err}`)
    }
  }

  dispose(): void {
    this.watcher?.dispose()
    this.disposables.forEach((d) => d.dispose())
    this._onBinaryChanged.dispose()
    this._onTextFileRegistered.dispose()
    this._onTextFileChangedExternally.dispose()
  }
}
