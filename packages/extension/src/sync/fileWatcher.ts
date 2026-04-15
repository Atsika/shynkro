import * as fs from "fs"
import * as vscode from "vscode"
import * as path from "path"
import type { WorkspaceId } from "@shynkro/shared"
import { ApiError } from "../api/restClient"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { WsManager } from "../ws/wsManager"
import { classifyFile, classifyFileWithContent } from "@shynkro/shared"
import { buildIgnoreMatcher } from "../ignoreUtils"
import { ensureShynkroInGitignore } from "../workspace/gitUtils"
import { log } from "../logger"
import { decodeTextFile } from "../text/textNormalize"

export class FileWatcher {
  private watcher: vscode.FileSystemWatcher | null = null
  private readonly writeTags = new Set<string>()
  private readonly disposables: vscode.Disposable[] = []
  private readonly ignoreMatcher: (relPath: string) => boolean
  /**
   * Pending deletes, debounced by 150 ms. When VS Code "replaces" a file
   * (drag-and-drop with overwrite, or copy-paste replace), it fires
   * `onDidDelete` then `onDidCreate` in rapid succession. Without
   * debouncing, the delete races the create: the server removes the file
   * before the create arrives, and the user's replacement file vanishes.
   *
   * The debounce gives `handleCreate` 150 ms to cancel a pending delete
   * for the same path. If a create fires within that window, the delete is
   * cancelled and the create is treated as a content update on the existing
   * file entry instead.
   */
  private readonly pendingDeletes = new Map<string, { timer: ReturnType<typeof setTimeout>; fileId: string; relPath: string }>()

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
      // VS Code surfaces user-initiated renames via this dedicated event before
      // the underlying filesystem watcher fires its delete+create pair. Catching
      // it here lets us preserve the docId / Yjs collaboration history across
      // renames instead of dropping it as a "delete then create new file".
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.handleRename(f.oldUri, f.newUri).catch((err) =>
            log.appendLine(`[watcher] handleRename error: ${err}`)
          )
        }
      }),
      gitWatcher,
      gitWatcher.onDidCreate(() => {
        log.appendLine("[watcher] .git detected — ensuring .shynkro/ in .gitignore")
        ensureShynkroInGitignore(this.workspaceRoot)
      })
    )
  }

  /**
   * Handle a user-initiated rename. We treat it as a first-class rename op so the
   * docId and Yjs collaboration history travel with the file. The underlying
   * filesystem watcher will still fire delete+create events for the same paths;
   * we suppress those by setting write tags on both sides ahead of time.
   */
  private async handleRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    if (this.shouldIgnore(oldUri) || this.shouldIgnore(newUri)) return

    const oldRel = path.relative(this.workspaceRoot, oldUri.fsPath).replace(/\\/g, "/")
    const newRel = path.relative(this.workspaceRoot, newUri.fsPath).replace(/\\/g, "/")
    if (oldRel === newRel) return

    const row = this.stateDb.getFileByPath(oldRel)
    if (!row) {
      // Unknown file — let the watcher's delete/create handle it as a fresh upload.
      return
    }

    // Suppress the delete/create echo from the underlying file system watcher.
    // Both events will fire after this handler returns; addWriteTag is one-shot.
    this.addWriteTag(oldUri.fsPath)
    this.addWriteTag(newUri.fsPath)

    if (!this.wsManager.connected) {
      // Persist the local move so reads see the new path immediately, and queue
      // the rename to replay against the server on next reconnect. The previous
      // path is encoded in `content` (re-used field) so the drain step can rebuild
      // the FileRenamedMessage payload.
      this.stateDb.renameFile(row.fileId, newRel)
      this.stateDb.enqueuePendingOp({
        opType: "rename",
        path: newRel,
        fileId: row.fileId,
        content: oldRel,
      })
      log.appendLine(`[watcher] offline — queued rename ${oldRel} → ${newRel}`)
      return
    }

    try {
      await this.restClient.renameFile(
        this.workspaceId,
        row.fileId as import("@shynkro/shared").FileId,
        { path: newRel }
      )
      this.stateDb.renameFile(row.fileId, newRel)
      log.appendLine(`[watcher] renamed ${oldRel} → ${newRel}`)
    } catch (err) {
      log.appendLine(`[watcher] handleRename REST error for ${oldRel} → ${newRel}: ${err}`)
      if (err instanceof ApiError && err.code === "PATH_CASE_COLLISION") {
        vscode.window.showWarningMessage(
          `Shynkro: cannot rename to "${newRel}" — ${err.message}`
        )
      }
    }
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
    // Write-tag check: a rename handler (or reconciler) already wrote this
    // path — consuming the tag prevents a spurious re-create. This also fixes
    // the rename-to-different-case race where handleCreate fires before
    // handleRename finishes updating stateDb, which would otherwise hit the
    // case-collision check against the not-yet-renamed old entry.
    if (this.writeTags.has(uri.fsPath)) {
      this.writeTags.delete(uri.fsPath)
      return
    }
    const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, "/")

    // If there is a pending debounced delete for this exact path, this is a
    // file-replace (drag-and-drop overwrite, copy-paste replace). Cancel the
    // delete and route through the change handler so the existing file entry
    // gets its content updated instead of being deleted and re-created.
    const pendingDel = this.pendingDeletes.get(uri.fsPath)
    if (pendingDel) {
      clearTimeout(pendingDel.timer)
      this.pendingDeletes.delete(uri.fsPath)
      log.appendLine(`[watcher] file-replace detected for ${relPath} — routing as change`)
      // Small delay to ensure the replacement file is fully flushed to disk
      // before we read it. VS Code fires onDidCreate as soon as the inode
      // exists, which can be before the content is fully written.
      setTimeout(() => {
        this.handleChange(uri).catch((err) =>
          log.appendLine(`[watcher] file-replace change error for ${relPath}: ${err}`)
        )
      }, 100)
      return
    }

    // Skip files already known (e.g. from import) — avoids 409 on init
    if (this.stateDb.getFileByPath(relPath)) return

    // Fast local case-insensitive collision check — catches the collision
    // before the server round-trip. VS Code already wrote the file to disk
    // by the time onDidCreate fires, so we can't prevent creation. We warn
    // the user and offer to delete. Not auto-deleting because the user may
    // have `mv`'d the file (original is gone — deleting would lose data).
    const ciCollision = this.stateDb.getFileByPathCI(relPath)
    if (ciCollision && ciCollision.path !== relPath) {
      log.appendLine(`[watcher] case collision: "${relPath}" vs existing "${ciCollision.path}"`)
      vscode.window.showWarningMessage(
        `Shynkro: "${path.basename(relPath)}" won't sync — "${path.basename(ciCollision.path)}" already exists (case-insensitive match). Rename or delete one of them.`,
        "Delete Local Copy",
        "Dismiss"
      ).then((choice) => {
        if (choice === "Delete Local Copy") {
          try { fs.rmSync(uri.fsPath, { force: true }) } catch {}
        }
      })
      return
    }
    let stat: fs.Stats
    try {
      // lstat (not stat) so we don't follow symlinks — symlinks are skipped below.
      stat = fs.lstatSync(uri.fsPath)
    } catch {
      return // path vanished before we could stat it
    }
    if (stat.isSymbolicLink()) {
      log.appendLine(`[watcher] skipping symlink: ${relPath}`)
      return
    }
    let kind = stat.isDirectory() ? "folder" as const : classifyFile(uri.fsPath)
    if (kind === null) {
      // Read only the first 4 KB for content-sniffing — istextorbinary's
      // heuristic looks at a leading window, so loading the whole file is
      // wasteful and OOM-prone for large unknown-extension files (zipped
      // scans, pcaps, anything without a recognizable suffix).
      try {
        const fd = fs.openSync(uri.fsPath, "r")
        try {
          const sniff = Buffer.alloc(Math.min(4096, stat.size))
          if (sniff.length > 0) fs.readSync(fd, sniff, 0, sniff.length, 0)
          kind = classifyFileWithContent(uri.fsPath, sniff)
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        kind = "text"
      }
    }

    // Reject text files larger than the import file size cap on the server,
    // since they would be rejected anyway by the REST endpoint and we'd waste
    // a full read+UTF-8 decode pass first. Match the server default; admins who
    // bump SHYNKRO_MAX_IMPORT_FILE_SIZE on the server will need to bump this
    // matching constant in a follow-up. The hard cap protects against an
    // accidental drag of a huge log file into the workspace.
    const TEXT_FILE_SOFT_MAX = 100 * 1024 * 1024
    if (kind === "text" && stat.isFile() && stat.size > TEXT_FILE_SOFT_MAX) {
      log.appendLine(`[watcher] skipping oversized text file ${relPath} (${stat.size} bytes > ${TEXT_FILE_SOFT_MAX})`)
      vscode.window.showWarningMessage(
        `Shynkro: "${relPath}" is too large for text sync (${Math.round(stat.size / 1024 / 1024)} MB). Convert to binary or split into smaller files.`
      )
      return
    }

    // Decode text content into canonical (LF, no BOM) form and remember the on-disk
    // format so write-back can faithfully reconstruct it on every collaborator's machine.
    let decoded: ReturnType<typeof decodeTextFile> | null = null
    if (kind === "text") {
      try {
        const raw = fs.readFileSync(uri.fsPath, "utf-8")
        decoded = decodeTextFile(raw)
      } catch (err) {
        log.appendLine(`[watcher] read error for ${relPath}: ${err}`)
        return
      }
    }
    // POSIX mode bits — meaningful on Linux/macOS, all peers preserve the bits we record.
    const mode = stat.isFile() ? (stat.mode & 0o777) : null

    if (!this.wsManager.connected) {
      this.stateDb.enqueuePendingOp({ opType: "create", path: relPath, kind, content: decoded?.content })
      log.appendLine(`[watcher] offline — queued create ${relPath}`)
      return
    }

    try {
      const file = await this.restClient.createFile(this.workspaceId, {
        path: relPath,
        kind,
        content: decoded?.content,
        mode: mode ?? undefined,
      })
      this.stateDb.upsertFile(file.id, relPath, kind, file.docId ?? undefined)
      if (decoded) this.stateDb.setTextFormat(file.id, decoded.eol, decoded.bom)
      if (mode !== null) this.stateDb.setFileMode(file.id, mode)
      log.appendLine(`[watcher] created ${relPath} id=${file.id} docId=${file.docId}`)
      if (kind === "text" && file.docId) {
        this._onTextFileRegistered.fire(uri.fsPath)
      } else if (kind === "binary") {
        this._onBinaryChanged.fire({ fileId: file.id as import("@shynkro/shared").FileId, localPath: uri.fsPath })
      }
    } catch (err) {
      log.appendLine(`[watcher] handleCreate error for ${relPath}: ${err}`)
      if (err instanceof ApiError && err.code === "PATH_CASE_COLLISION") {
        // Server-side fallback (race: another client created the collision
        // between our local check and the server call).
        vscode.window.showWarningMessage(
          `Shynkro: "${path.basename(relPath)}" won't sync — a file with the same name (different case) already exists in this workspace. Rename or delete one of them.`,
          "Delete Local Copy",
          "Dismiss"
        ).then((choice) => {
          if (choice === "Delete Local Copy") {
            try { fs.rmSync(uri.fsPath, { force: true }) } catch {}
          }
        })
      }
    }
  }

  private readonly _onTextFileRegistered = new vscode.EventEmitter<string>()
  readonly onTextFileRegistered = this._onTextFileRegistered.event

  async handleChange(uri: vscode.Uri): Promise<void> {
    if (this.shouldIgnore(uri)) return
    if (this.writeTags.has(uri.fsPath)) {
      this.writeTags.delete(uri.fsPath)
      return
    }
    const relPath = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, "/")
    const row = this.stateDb.getFileByPath(relPath)
    if (!row) {
      log.appendLine(`[watcher] handleChange: no stateDb row for ${relPath} — skipping`)
      return
    }

    if (row.kind === "binary") {
      log.appendLine(`[watcher] handleChange: binary changed ${relPath}`)
      this._onBinaryChanged.fire({ fileId: row.fileId as import("@shynkro/shared").FileId, localPath: uri.fsPath })
    } else if (row.kind === "text" && row.docId) {
      log.appendLine(`[watcher] handleChange: text changed externally ${relPath}`)
      this._onTextFileChangedExternally.fire({ fileId: row.fileId as import("@shynkro/shared").FileId, docId: row.docId, filePath: uri.fsPath })
    } else {
      log.appendLine(`[watcher] handleChange: unhandled kind=${row.kind} docId=${row.docId} for ${relPath}`)
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

    // Debounce: when VS Code "replaces" a file (drag-and-drop overwrite, copy-paste
    // replace), it fires onDidDelete then onDidCreate in rapid succession. Without
    // debouncing, the delete races the create — the server removes the file before
    // the create arrives and the replacement file vanishes. The 150 ms window gives
    // handleCreate a chance to cancel the pending delete and treat the whole
    // operation as a content update on the existing file entry.
    const existing = this.pendingDeletes.get(uri.fsPath)
    if (existing) clearTimeout(existing.timer)

    const timer = setTimeout(() => {
      this.pendingDeletes.delete(uri.fsPath)
      this.executeDelete(uri, row.fileId, relPath)
    }, 150)
    this.pendingDeletes.set(uri.fsPath, { timer, fileId: row.fileId, relPath })
  }

  /** Actually run the delete after the debounce window expires. */
  private executeDelete(uri: vscode.Uri, fileId: string, relPath: string): void {
    this.stateDb.deleteFile(fileId)
    this._onFileDeleted.fire({ absPath: uri.fsPath, remote: false })

    if (!this.wsManager.connected) {
      this.stateDb.enqueuePendingOp({ opType: "delete", path: relPath, fileId })
      log.appendLine(`[watcher] offline — queued delete ${relPath}`)
      return
    }

    this.restClient.deleteFile(this.workspaceId, fileId as import("@shynkro/shared").FileId)
      .catch((err) => log.appendLine(`[watcher] handleDelete error for ${relPath}: ${err}`))
  }

  /** Fires when a tracked file is deleted locally or remotely. */
  private readonly _onFileDeleted = new vscode.EventEmitter<{ absPath: string; remote: boolean }>()
  readonly onFileDeleted = this._onFileDeleted.event

  dispose(): void {
    // E5: Cancel all pending delete timers to prevent firing on closed stateDb
    for (const pending of this.pendingDeletes.values()) clearTimeout(pending.timer)
    this.pendingDeletes.clear()
    this.watcher?.dispose()
    this.disposables.forEach((d) => d.dispose())
    this._onBinaryChanged.dispose()
    this._onTextFileRegistered.dispose()
    this._onTextFileChangedExternally.dispose()
    this._onFileDeleted.dispose()
  }
}
