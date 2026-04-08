import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import * as Y from "yjs"
import { WS_BINARY_YJS_UPDATE, WS_BINARY_YJS_STATE, WS_BINARY_AWARENESS } from "@shynkro/shared"
import type { CursorPayload, DocId, FileId, Role, WorkspaceId } from "@shynkro/shared"
import type { WsManager } from "../ws/wsManager"
import type { FileWatcher } from "../sync/fileWatcher"
import { ConflictManager } from "../conflict/conflictManager"
import { log } from "../logger"
import { decodeTextFile, encodeTextForDisk, defaultEol, toLf, fromLf } from "../text/textNormalize"
import { atomicWriteFileSync } from "../text/atomicWrite"

/**
 * Convert an editor offset (which counts `\r\n` as 2 characters when the document's
 * EOL is CRLF) to the equivalent offset inside the canonical LF Yjs text.
 *
 * Each `\r` character in the editor representation has no counterpart in the LF
 * representation, so the LF offset is `editorOffset` minus the number of `\r`s
 * appearing before that position in `editorText`.
 *
 * Cheap O(n) scan; called on every keystroke but `n` is bounded by the cursor
 * position, not the whole file.
 */
function editorOffsetToLfOffset(editorText: string, editorOffset: number): number {
  let crCount = 0
  const limit = Math.min(editorOffset, editorText.length)
  for (let i = 0; i < limit; i++) {
    if (editorText.charCodeAt(i) === 13 /* \r */) crCount++
  }
  return editorOffset - crCount
}

/**
 * Count `\r` characters in `editorText[from..from+length)` — used to translate a
 * `change.rangeLength` (editor units) into the corresponding number of LF units.
 */
function countCrInRange(editorText: string, from: number, length: number): number {
  const end = Math.min(from + length, editorText.length)
  let cr = 0
  for (let i = from; i < end; i++) {
    if (editorText.charCodeAt(i) === 13 /* \r */) cr++
  }
  return cr
}

interface DocEntry {
  yDoc: Y.Doc
  fileId: FileId
  filePath: string
  workspaceId: WorkspaceId
  editor: vscode.TextEditor
  applyingRemote: number  // counter: >0 means a remote edit is in-flight
  hasReceivedState: boolean  // true once WS_BINARY_YJS_STATE has been applied
  pendingConflict: boolean   // true while conflict dialog is showing — blocks editor updates
  /** Shadow Y.Doc that tracks the server state while a conflict is pending. */
  conflictServerDoc: Y.Doc | null
  /** The server text when the conflict was started — used to detect server changes during resolution. */
  conflictOriginalServerText: string | null
  /**
   * Frames that arrived during the narrow window of applyFinalText where
   * `conflictServerDoc` has been destroyed but `pendingConflict` is still true.
   * Drained into `yDoc` at the end of applyFinalText, before `pendingConflict` is
   * cleared. Ensures no server update can slip through and silently overwrite
   * the user's resolution even if a future refactor introduces a yield point
   * in the conflict tail (today the window is zero ticks, but this is cheap
   * insurance against regression).
   */
  conflictBufferedFrames: Uint8Array[] | null
}

interface BackgroundEntry {
  yDoc: Y.Doc
  filePath: string
  workspaceId: WorkspaceId
  writeTimer: ReturnType<typeof setTimeout> | null
  hasReceivedState: boolean
  pendingConflict: boolean
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function buildBinaryFrame(frameType: number, docId: string, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 16 + data.length)
  frame[0] = frameType
  frame.set(uuidToBytes(docId), 1)
  frame.set(data, 17)
  return frame
}

const CURSOR_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
  "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
]

interface RemoteCursorState {
  color: string
  cursorDecoration: vscode.TextEditorDecorationType
  labelAboveDecoration: vscode.TextEditorDecorationType  // line > 0
  labelBelowDecoration: vscode.TextEditorDecorationType  // line 0 fallback
  selectionDecoration: vscode.TextEditorDecorationType
  expiryTimer: ReturnType<typeof setTimeout> | null
  activeEditor: vscode.TextEditor | null
}

export class YjsBridge {
  private readonly docs = new Map<string, DocEntry>()
  private readonly backgroundDocs = new Map<string, BackgroundEntry>()
  private readonly updateHandlers = new Map<string, (update: Uint8Array, origin: unknown) => void>()
  private readonly disposables: vscode.Disposable[] = []
  private currentRole: Role = "editor"  // overridden by setRole() on connect
  private permissionPopupShown = false
  private viewerResyncTimer: ReturnType<typeof setTimeout> | null = null
  private username = ""
  private readonly remoteCursors = new Map<string, RemoteCursorState>()
  private readonly selectionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly hiddenLabels = new Set<string>()
  private lastActiveDocId: string | null = null
  private followingUserId: string | null = null
  private lastFollowedDocId: string | null = null

  constructor(
    private readonly wsManager: WsManager,
    private readonly fileWatcher: FileWatcher,
    private readonly conflictManager: ConflictManager,
    private readonly stateDb: import("../state/stateDb").StateDb,
    private readonly workspaceRoot: string
  ) {
    this.disposables.push(
      wsManager.onBinaryFrame((frame) => this.handleBinaryFrame(frame)),
      vscode.workspace.onDidChangeTextDocument((e) => this.handleLocalEdit(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.handleDocClose(doc)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Viewer read-only enforcement
        if (editor && this.currentRole === "viewer" && this.isTrackedPath(editor.document.uri.fsPath)) {
          vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
          const docEntry = [...this.docs.values()].find(e => e.editor.document === editor.document)
          if (docEntry) this.showPermissionRequestPopup(docEntry.workspaceId)
        }

        // Clear cursor from the previous doc when switching files
        const newDocId = editor ? this.findDocIdForPath(editor.document.uri.fsPath) : null
        if (this.lastActiveDocId && this.lastActiveDocId !== newDocId) {
          this.sendCursorClear(this.lastActiveDocId)
        }
        this.lastActiveDocId = newDocId
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        for (const [docId, entry] of this.docs) {
          if (entry.editor.document.uri.fsPath !== e.textEditor.document.uri.fsPath) continue
          // Refresh stale editor reference and track active doc
          entry.editor = e.textEditor
          this.lastActiveDocId = docId
          if (entry.applyingRemote > 0) break
          const existing = this.selectionTimers.get(docId)
          if (existing) clearTimeout(existing)
          this.selectionTimers.set(docId, setTimeout(() => {
            this.selectionTimers.delete(docId)
            this.sendCursorUpdate(docId, entry, e.textEditor.selection)
          }, 50))
          break
        }
      }),
    )
  }

  /**
   * Subscribe to a doc tied to an open editor.
   * If the doc was already in background sync, migrate its Y.Doc (avoids re-fetching state).
   */
  openDoc(fileId: FileId, docId: DocId, workspaceId: WorkspaceId, filePath: string, editor: vscode.TextEditor): void {
    const existing = this.docs.get(docId)
    if (existing) {
      // Update editor reference in case it changed (e.g. after reload)
      existing.editor = editor
      return
    }

    // Evict stale entries for the same file path (e.g. file was deleted and recreated with a new docId)
    for (const [oldDocId, oldEntry] of this.docs) {
      if (oldEntry.filePath === filePath && oldDocId !== docId) {
        log.appendLine(`[yjsBridge] evicting stale doc entry ${oldDocId} for ${path.basename(filePath)}`)
        const oldHandler = this.updateHandlers.get(oldDocId)
        if (oldHandler) { oldEntry.yDoc.off("update", oldHandler); this.updateHandlers.delete(oldDocId) }
        oldEntry.yDoc.destroy()
        this.docs.delete(oldDocId)
      }
    }
    for (const [oldDocId, oldBg] of this.backgroundDocs) {
      if (oldBg.filePath === filePath && oldDocId !== docId) {
        log.appendLine(`[yjsBridge] evicting stale background entry ${oldDocId} for ${path.basename(filePath)}`)
        if (oldBg.writeTimer) clearTimeout(oldBg.writeTimer)
        oldBg.yDoc.destroy()
        this.backgroundDocs.delete(oldDocId)
      }
    }

    let yDoc: Y.Doc
    const bgEntry = this.backgroundDocs.get(docId)

    if (bgEntry) {
      // Migrate from background — reuse the Y.Doc so we keep accumulated state
      if (bgEntry.writeTimer) clearTimeout(bgEntry.writeTimer)
      yDoc = bgEntry.yDoc
      this.backgroundDocs.delete(docId)
      // Remove old update listeners to prevent accumulation across close/reopen cycles
      yDoc.off("update", this.getUpdateHandler(docId))
      log.appendLine(`[yjsBridge] openDoc (migrated from background) ${path.basename(filePath)}`)
    } else {
      yDoc = new Y.Doc()
      log.appendLine(`[yjsBridge] openDoc ${path.basename(filePath)} docId=${docId}`)
      // Not yet subscribed — ask the server for the current state
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId })
    }

    const hasSuspendedConflict = this.conflictManager.hasSuspended(docId)
    const entry: DocEntry = {
      yDoc, fileId, filePath, workspaceId, editor, applyingRemote: 0,
      hasReceivedState: !!(bgEntry && bgEntry.hasReceivedState),
      // Keep pendingConflict true if there is a suspended conflict waiting to resume
      pendingConflict: hasSuspendedConflict || !!(bgEntry?.pendingConflict),
      conflictServerDoc: null,
      conflictOriginalServerText: null,
      conflictBufferedFrames: null,
    }
    this.docs.set(docId, entry)

    if (this.currentRole === "viewer") {
      vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
    }

    // Send local edits to server (use a stable handler so it can be removed later)
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return
      const frame = buildBinaryFrame(WS_BINARY_YJS_UPDATE, docId, update)
      this.wsManager.sendBinary(frame)
    }
    this.updateHandlers.set(docId, handler)
    yDoc.on("update", handler)

    if (hasSuspendedConflict || bgEntry?.pendingConflict) {
      // Re-inject conflict markers into the newly opened editor
      this.conflictManager.resume(docId, editor).catch((err) => {
        log.appendLine(`[yjsBridge] conflict resume error: ${err}`)
        entry.pendingConflict = false
      })
    } else if (bgEntry && bgEntry.hasReceivedState) {
      // Normal case: push the Y.Doc content into the editor
      this.applyDocToEditor(entry)
    }
  }

  /**
   * Subscribe to a doc without an editor — receives updates and writes to disk.
   * Called for all known text files at WS connect time and when new files arrive.
   */
  subscribeBackground(docId: string, workspaceId: WorkspaceId, filePath: string): void {
    if (this.docs.has(docId) || this.backgroundDocs.has(docId)) return

    // Evict stale entries for the same file path
    for (const [oldDocId, oldEntry] of this.docs) {
      if (oldEntry.filePath === filePath && oldDocId !== docId) {
        log.appendLine(`[yjsBridge] evicting stale doc entry ${oldDocId} for ${path.basename(filePath)}`)
        const oldHandler = this.updateHandlers.get(oldDocId)
        if (oldHandler) { oldEntry.yDoc.off("update", oldHandler); this.updateHandlers.delete(oldDocId) }
        oldEntry.yDoc.destroy()
        this.docs.delete(oldDocId)
      }
    }
    for (const [oldDocId, oldBg] of this.backgroundDocs) {
      if (oldBg.filePath === filePath && oldDocId !== docId) {
        log.appendLine(`[yjsBridge] evicting stale background entry ${oldDocId} for ${path.basename(filePath)}`)
        if (oldBg.writeTimer) clearTimeout(oldBg.writeTimer)
        oldBg.yDoc.destroy()
        this.backgroundDocs.delete(oldDocId)
      }
    }

    log.appendLine(`[yjsBridge] subscribeBackground ${path.basename(filePath)}`)
    const yDoc = new Y.Doc()
    this.backgroundDocs.set(docId, { yDoc, filePath, workspaceId, writeTimer: null, hasReceivedState: false, pendingConflict: false })
    this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId: docId as DocId })
  }

  private getUpdateHandler(docId: string): (update: Uint8Array, origin: unknown) => void {
    return this.updateHandlers.get(docId) ?? (() => {})
  }

  /** Re-subscribe all open + background docs after a reconnect. */
  notifyConnected(workspaceId: WorkspaceId): void {
    for (const [docId, entry] of this.docs) {
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId: docId as DocId })
      entry.applyingRemote = 0
      // On reconnect, the server will send a fresh YJS_STATE — gate local edits until then
      entry.hasReceivedState = false
    }
    for (const [docId, bgEntry] of this.backgroundDocs) {
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId: bgEntry.workspaceId, docId: docId as DocId })
    }
  }

  setRole(role: Role): void {
    const wasViewer = this.currentRole === "viewer"
    const wasEditor = this.currentRole !== "viewer"
    this.currentRole = role
    if (role === "viewer") {
      // Lock every visible tracked editor — session-readonly is per-document, so
      // iterating visible editors catches split-view and background tabs that
      // would otherwise stay writable and silently drop edits server-side.
      this.lockAllTrackedEditors()

      if (wasEditor) {
        // Critical: between "server applied demotion" and "client received the
        // permissionChanged message", the user may have typed edits that the
        // server silently rejected (realtime.ts:54 viewer check). The local
        // Y.Doc still holds those edits — if we don't resync, handleLocalEdit's
        // revert-to-yDoc-truth would restore the phantom edits and the user
        // would think their work saved.
        //
        // Re-subscribing forces the server to send a fresh WS_BINARY_YJS_STATE
        // frame; handleBinaryFrame will overwrite the local Y.Doc with the
        // authoritative server state and push it into the editor. Any unsent
        // edits are discarded (correct behavior for a demoted viewer).
        for (const [docId, entry] of this.docs) {
          entry.hasReceivedState = false
          this.wsManager.sendJson({ type: "subscribeDoc", workspaceId: entry.workspaceId, docId: docId as DocId })
        }
        // Surface the demotion in the status bar so the user actually notices —
        // a transient toast is easy to dismiss and the old code had no persistent
        // indicator.
        this.setViewerStatusBar(true)
      }
    } else {
      this.permissionPopupShown = false
      this.setViewerStatusBar(false)
      if (wasViewer) {
        // Unlock ALL tracked visible editors — session-readonly is per-document so we must
        // temporarily focus each locked tab and run the command, then restore focus.
        this.unlockAllTrackedEditors()
        // Resync all open docs: editor may have drifted from Yjs while viewer.
        // Without this, handleLocalEdit would compute wrong offsets and corrupt the Yjs doc.
        for (const entry of this.docs.values()) {
          this.applyDocToEditor(entry)
        }
      }
    }
  }

  /** Status bar item surfacing the viewer-only indicator. Lazily created. */
  private viewerStatusBarItem: vscode.StatusBarItem | null = null
  private setViewerStatusBar(visible: boolean): void {
    if (visible) {
      if (!this.viewerStatusBarItem) {
        this.viewerStatusBarItem = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Left,
          50
        )
        this.viewerStatusBarItem.text = "$(eye) Shynkro: Viewer (read-only)"
        this.viewerStatusBarItem.tooltip =
          "You are a viewer in this workspace — your edits are NOT saved to the server. Request editor access from the workspace owner."
        this.viewerStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
      }
      this.viewerStatusBarItem.show()
    } else {
      this.viewerStatusBarItem?.hide()
    }
  }

  /** Inverse of unlockAllTrackedEditors — session-readonly every visible tracked editor. */
  private lockAllTrackedEditors(): void {
    const toLock = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.scheme === "file" && this.isTrackedPath(e.document.uri.fsPath)
    )
    if (toLock.length === 0) return
    const original = vscode.window.activeTextEditor
    ;(async () => {
      for (const editor of toLock) {
        await vscode.window.showTextDocument(editor.document, { preserveFocus: false, preview: false })
        await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
      }
      if (original) {
        await vscode.window.showTextDocument(original.document, { preserveFocus: false, preview: false })
      }
    })().catch(() => {})
  }

  setUsername(name: string): void {
    this.username = name
  }

  private unlockAllTrackedEditors(): void {
    const toUnlock = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.scheme === "file" && this.isTrackedPath(e.document.uri.fsPath)
    )
    if (toUnlock.length === 0) return
    const original = vscode.window.activeTextEditor
    ;(async () => {
      for (const editor of toUnlock) {
        await vscode.window.showTextDocument(editor.document, { preserveFocus: false, preview: false })
        await vscode.commands.executeCommand("workbench.action.files.setActiveEditorWriteableInSession")
      }
      if (original) {
        await vscode.window.showTextDocument(original.document, { preserveFocus: false, preview: false })
      }
    })().catch(() => {})
  }

  private isTrackedPath(fsPath: string): boolean {
    return this.findDocIdForPath(fsPath) !== null
  }

  private findDocIdForPath(fsPath: string): string | null {
    for (const [docId, entry] of this.docs) {
      if (entry.filePath === fsPath) return docId
    }
    return null
  }

  closeDoc(docId: DocId): void {
    const entry = this.docs.get(docId)
    if (!entry) return
    this.wsManager.sendJson({ type: "unsubscribeDoc", docId })
    entry.yDoc.destroy()
    entry.conflictServerDoc?.destroy()
    this.docs.delete(docId)
    this.updateHandlers.delete(docId)
  }

  /**
   * Called when a file has been deleted (locally by the user, or remotely via WS
   * broadcast). Tears down the Y.Doc subscription, closes the editor tab, and
   * prompts the user to save a local copy if they had unsaved changes and the
   * deletion was initiated remotely.
   *
   * Previously, the editor stayed open and editable after deletion — the user
   * could keep typing into a doc that no longer existed on the server, with every
   * keystroke silently dropped. This ensures the in-memory state matches the
   * wire state after a delete, for both tabs and Y.Doc subscriptions.
   */
  async handleFileDeleted(absPath: string, opts: { remote: boolean; deletedBy?: string }): Promise<void> {
    // Find the docId from either active docs or background docs by path match.
    let matchedDocId: string | null = null
    let matchedEntry: DocEntry | null = null
    for (const [docId, entry] of this.docs) {
      if (entry.filePath === absPath) {
        matchedDocId = docId
        matchedEntry = entry
        break
      }
    }
    if (!matchedDocId) {
      for (const [docId, bg] of this.backgroundDocs) {
        if (bg.filePath === absPath) {
          matchedDocId = docId
          // Clean up the background entry now — no editor to close for background docs.
          if (bg.writeTimer) clearTimeout(bg.writeTimer)
          this.wsManager.sendJson({ type: "unsubscribeDoc", docId: docId as DocId })
          bg.yDoc.destroy()
          this.backgroundDocs.delete(docId)
          log.appendLine(`[yjsBridge] closed background doc for deleted file ${path.basename(absPath)}`)
          return
        }
      }
    }
    if (!matchedDocId || !matchedEntry) return

    // Find any live VS Code tab for this path and close it. Unsaved local edits
    // trigger a prompt only when the delete came from another collaborator — a
    // user deleting their own file already intended to discard unsaved changes.
    const doc = matchedEntry.editor.document
    const isDirty = !doc.isClosed && doc.isDirty
    if (opts.remote && isDirty) {
      const who = opts.deletedBy ? ` by ${opts.deletedBy}` : ""
      const choice = await vscode.window.showWarningMessage(
        `Shynkro: "${path.basename(absPath)}" was deleted${who}, but you have unsaved changes. Save a local copy?`,
        { modal: true },
        "Save Local Copy",
        "Discard"
      )
      if (choice === "Save Local Copy") {
        // Write the dirty editor content to a sibling .recovered file so it
        // isn't lost when the editor tab is force-closed.
        const recoveredPath = `${absPath}.recovered-${Date.now()}`
        try {
          fs.writeFileSync(recoveredPath, doc.getText(), "utf-8")
          vscode.window.showInformationMessage(`Shynkro: saved recovery copy at ${path.basename(recoveredPath)}`)
        } catch (err) {
          log.appendLine(`[yjsBridge] failed to write recovery copy ${recoveredPath}: ${err}`)
        }
      }
    }

    // Tear down the Y.Doc subscription and associated state. closeDoc handles
    // the unsubscribe + destroy; we also clean up any pending conflict state
    // that references this doc so the conflict view no longer shows it.
    this.closeDoc(matchedDocId as DocId)
    this.conflictManager.clear(matchedDocId)

    // Close the editor tab if it is still open. VS Code's tabGroups API takes
    // a Tab or readonly Tab[] — we look up the tab matching this doc's URI.
    try {
      const uri = doc.uri
      const tabsToClose: vscode.Tab[] = []
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined
          if (input?.uri?.toString() === uri.toString()) tabsToClose.push(tab)
        }
      }
      if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose, true)
      }
    } catch (err) {
      log.appendLine(`[yjsBridge] failed to close tabs for deleted file ${path.basename(absPath)}: ${err}`)
    }
  }

  /**
   * Called when a tracked text file is modified by an external tool (e.g. vim, git).
   * Applies the new disk content to the Yjs doc so it propagates to the server and peers.
   *
   * Disk content is normalized to canonical LF / no-BOM form before reaching the Y.Doc.
   * If this is the first time we've seen the file (no eol_style stored), we sniff the
   * format from the disk content and remember it for future write-backs.
   */
  handleExternalTextEdit(filePath: string, docId: string): void {
    let rawDiskText: string
    try {
      rawDiskText = fs.readFileSync(filePath, "utf-8")
    } catch {
      return
    }
    const decoded = decodeTextFile(rawDiskText)
    const diskText = decoded.content
    // Persist the format the first time we see it for this file. We look up the row
    // by path because handleExternalTextEdit doesn't carry the fileId — and the path
    // → fileId mapping is what stateDb is built around.
    const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, "/")
    const row = this.stateDb.getFileByPath(relPath)
    if (row && row.eolStyle === null) {
      this.stateDb.setTextFormat(row.fileId, decoded.eol, decoded.bom)
    }

    // Helper: apply newText to yDoc using prefix/suffix ops (CRDT-friendly)
    const applyOps = (yDoc: Y.Doc): void => {
      const yText = yDoc.getText("content")
      const baseText = yText.toString()
      if (baseText === diskText) return
      let prefixLen = 0
      const minLen = Math.min(baseText.length, diskText.length)
      while (prefixLen < minLen && baseText[prefixLen] === diskText[prefixLen]) prefixLen++
      let suffixLen = 0
      const maxSuffix = minLen - prefixLen
      while (
        suffixLen < maxSuffix &&
        baseText[baseText.length - 1 - suffixLen] === diskText[diskText.length - 1 - suffixLen]
      ) suffixLen++
      const deleteStart = prefixLen
      const deleteLen = baseText.length - prefixLen - suffixLen
      const insertText = diskText.slice(prefixLen, suffixLen > 0 ? diskText.length - suffixLen : undefined)
      yDoc.transact(() => {
        if (deleteLen > 0) yText.delete(deleteStart, deleteLen)
        if (insertText.length > 0) yText.insert(deleteStart, insertText)
      })
    }

    // Case 1: file is open in editor
    const entry = this.docs.get(docId)
    if (entry) {
      if (entry.pendingConflict) return
      entry.applyingRemote++
      applyOps(entry.yDoc)
      entry.applyingRemote--
      this.applyDocToEditor(entry)
      return
    }

    // Case 2: file is in background (not open in editor) — the vim/external edit bug
    const bgEntry = this.backgroundDocs.get(docId)
    if (bgEntry && bgEntry.hasReceivedState) {
      // Background docs have no update handler — capture the update and send it manually
      const capturedUpdates: Uint8Array[] = []
      const tempHandler = (update: Uint8Array, origin: unknown) => {
        if (origin !== "remote") capturedUpdates.push(update)
      }
      bgEntry.yDoc.on("update", tempHandler)
      applyOps(bgEntry.yDoc)
      bgEntry.yDoc.off("update", tempHandler)
      for (const update of capturedUpdates) {
        const frame = buildBinaryFrame(WS_BINARY_YJS_UPDATE, docId, update)
        this.wsManager.sendBinary(frame)
      }
    }
  }

  private handleBinaryFrame(frame: { frameType: number; docId: string; data: Uint8Array }): void {
    const entry = this.docs.get(frame.docId)
    if (entry) {
      if (frame.frameType === WS_BINARY_YJS_STATE || frame.frameType === WS_BINARY_YJS_UPDATE) {
        const isInitialState = frame.frameType === WS_BINARY_YJS_STATE

        if (isInitialState) {
          if (entry.pendingConflict) {
            if (entry.conflictServerDoc) {
              // Active conflict with a tracking doc — absorb the new server state and live-update the UI.
              Y.applyUpdate(entry.conflictServerDoc, frame.data, "remote")
              const newServerText = entry.conflictServerDoc.getText("content").toString()
              entry.conflictOriginalServerText = newServerText
              this.conflictManager.updateServerText(frame.docId, newServerText).catch(() => {})
              log.appendLine(`[yjsBridge] updated conflictServerDoc from WS_BINARY_YJS_STATE for ${path.basename(entry.filePath)}`)
              return
            }
            // pendingConflict=true but no conflictServerDoc — this is the tail of
            // applyFinalText, between `conflictServerDoc = null` and `pendingConflict = false`.
            // Buffer the frame and drain it when applyFinalText finishes, rather than
            // dropping it silently. Prevents a future async refactor from turning this
            // into a silent-overwrite path.
            if (!entry.conflictBufferedFrames) entry.conflictBufferedFrames = []
            entry.conflictBufferedFrames.push(frame.data)
            log.appendLine(`[yjsBridge] buffered state frame during conflict tail for ${path.basename(entry.filePath)}`)
            return
          }

          // Decode server content into a temp doc (don't touch the real Y.Doc yet)
          const tempDoc = new Y.Doc()
          Y.applyUpdate(tempDoc, frame.data, "remote")
          const serverText = tempDoc.getText("content").toString() // canonical LF
          tempDoc.destroy()

          // Compare in canonical LF form so a Linux/Windows EOL mismatch on disk
          // does not look like a conflict.
          const editorText = toLf(entry.editor.document.getText())

          if (editorText !== serverText && editorText.length > 0 && serverText.length > 0) {
            // Check if the divergence is just a stale editor buffer — e.g. the file was
            // overwritten on disk by a clone without VS Code reloading the open editor.
            // If disk already has the server content and the user hasn't made unsaved edits,
            // the editor is simply stale: apply the server state silently.
            let diskText: string | null = null
            try {
              const raw = fs.readFileSync(entry.filePath, "utf-8")
              // Strip BOM and CRLF on the disk side too — same canonical form as server.
              diskText = decodeTextFile(raw).content
            } catch {}
            const editorIsStale = diskText === serverText && !entry.editor.document.isDirty

            if (editorIsStale) {
              log.appendLine(`[yjsBridge] stale editor (disk matches server) — applying silently: ${path.basename(entry.filePath)}`)
              Y.applyUpdate(entry.yDoc, frame.data, "remote")
              this.applyDocToEditor(entry, 3, () => { entry.hasReceivedState = true })
            } else {
              // Genuine divergence — let user resolve
              log.appendLine(`[yjsBridge] DIVERGED ${path.basename(entry.filePath)}: local=${editorText.length}, server=${serverText.length}`)
              entry.pendingConflict = true
              this.offerReconnectChoice(entry, frame.docId, frame.data, editorText, serverText)
            }
          } else {
            // No divergence — apply server state normally
            Y.applyUpdate(entry.yDoc, frame.data, "remote")
            this.applyDocToEditor(entry, 3, () => {
              entry.hasReceivedState = true
            })
          }
        } else {
          // Incremental update path.
          if (entry.pendingConflict) {
            if (entry.conflictServerDoc) {
              // Apply to the shadow doc so the conflict UI stays live, AND to the
              // real yDoc so on-screen text stays current. The fresh yDoc built by
              // applyFinalText will be seeded from conflictServerDoc, so this is
              // idempotent with respect to eventual state.
              Y.applyUpdate(entry.yDoc, frame.data, "remote")
              Y.applyUpdate(entry.conflictServerDoc, frame.data, "remote")
              const newServerText = entry.conflictServerDoc.getText("content").toString()
              entry.conflictOriginalServerText = newServerText
              this.conflictManager.updateServerText(frame.docId, newServerText).catch(() => {})
              // Editor stays in conflict-markers view while pendingConflict — do not
              // push the update through applyDocToEditor (which would clobber markers).
              return
            }
            // Conflict tail window (same as state-frame path): buffer and drain
            // at the end of applyFinalText. Keeps the fresh yDoc up-to-date with
            // any remote updates that slipped in between destroy and rebuild.
            if (!entry.conflictBufferedFrames) entry.conflictBufferedFrames = []
            entry.conflictBufferedFrames.push(frame.data)
            log.appendLine(`[yjsBridge] buffered update frame during conflict tail for ${path.basename(entry.filePath)}`)
            return
          }

          // Normal (non-conflict) path — apply and push to editor.
          const before = entry.yDoc.getText("content").toString()
          Y.applyUpdate(entry.yDoc, frame.data, "remote")
          const after = entry.yDoc.getText("content").toString()
          if (before !== after) {
            log.appendLine(`[yjsBridge] update applied ${path.basename(entry.filePath)}: ${before.length} → ${after.length}`)
            this.applyDocToEditor(entry)
          }
        }
      } else if (frame.frameType === WS_BINARY_AWARENESS) {
        // Awareness (cursor/selection) — only meaningful when doc is open in an editor
        try {
          const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
          if (payload.userId !== this.wsManager.userId) {
            this.applyRemoteCursor(frame.docId, entry, payload)
            if (payload.userId === this.followingUserId) {
              this.applyFollowNavigation(frame.docId, entry.filePath, payload)
            }
          }
        } catch {
          // malformed awareness payload — ignore
        }
      }
      return
    }

    const bgEntry = this.backgroundDocs.get(frame.docId)
    if (bgEntry) {
      if (frame.frameType === WS_BINARY_YJS_STATE || frame.frameType === WS_BINARY_YJS_UPDATE) {
        // While a conflict is suspended for this doc, block incoming updates —
        // the Y.Doc state will be rebuilt from the user's resolution when they reopen.
        if (bgEntry.pendingConflict) return

        // Capture state before applying — for conflict detection. Read disk in
        // canonical LF / no-BOM form so a CRLF↔LF mismatch on disk doesn't look
        // like a conflict.
        let localTextBefore: string | null = null
        if (frame.frameType === WS_BINARY_YJS_STATE) {
          bgEntry.hasReceivedState = true
          try {
            const raw = fs.readFileSync(bgEntry.filePath, "utf-8")
            const decoded = decodeTextFile(raw)
            localTextBefore = decoded.content
            // Persist sniffed format on first sight (matches handleExternalTextEdit).
            const relPath = path.relative(this.workspaceRoot, bgEntry.filePath).replace(/\\/g, "/")
            const row = this.stateDb.getFileByPath(relPath)
            if (row && row.eolStyle === null) {
              this.stateDb.setTextFormat(row.fileId, decoded.eol, decoded.bom)
            }
          } catch {}
        }

        Y.applyUpdate(bgEntry.yDoc, frame.data, "remote")
        this.scheduleBackgroundWrite(frame.docId, bgEntry)

        // On initial state: if disk had content that differs, offer to revert
        if (localTextBefore !== null && localTextBefore.length > 0) {
          const remoteText = bgEntry.yDoc.getText("content").toString()
          if (localTextBefore !== remoteText) {
            log.appendLine(`[yjsBridge] BACKGROUND CONFLICT for ${path.basename(bgEntry.filePath)}: local=${localTextBefore.length}, remote=${remoteText.length}`)
            this.offerBackgroundConflictResolution(bgEntry, frame.docId, localTextBefore, remoteText)
          }
        }
      } else if (frame.frameType === WS_BINARY_AWARENESS) {
        if (this.followingUserId) {
          try {
            const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
            if (payload.userId === this.followingUserId) {
              this.applyFollowNavigation(frame.docId, bgEntry.filePath, payload)
            }
          } catch {}
        }
      }
      return
    }

    log.appendLine(`[yjsBridge] binaryFrame type=${frame.frameType} docId=${frame.docId} mode=unknown`)
  }

  /**
   * On reconnect: server and local differ.
   * Injects inline conflict markers into the editor so the user can resolve per-hunk.
   * Yjs sync for this doc is gated (pendingConflict = true) until resolved.
   */
  private offerReconnectChoice(
    entry: DocEntry, docId: string, serverStateData: Uint8Array,
    localText: string, serverText: string
  ): void {
    // Build a shadow Y.Doc that will track the server state throughout conflict resolution.
    // Any WS_BINARY_YJS_STATE / WS_BINARY_YJS_UPDATE that arrives while the conflict is
    // pending is applied to this doc, so applyFinalText always works against the latest
    // server state rather than the (potentially stale) state at conflict-start time.
    if (entry.conflictServerDoc) entry.conflictServerDoc.destroy()
    const trackingDoc = new Y.Doc()
    Y.applyUpdate(trackingDoc, serverStateData, "remote")
    entry.conflictServerDoc = trackingDoc
    entry.conflictOriginalServerText = serverText

    this.conflictManager.startConflict(
      docId,
      entry.editor,
      localText,
      serverText,
      (finalText) => {
        // pendingConflict stays true until applyFinalText completes —
        // this blocks any WS_BINARY_YJS_STATE that arrives during the Y.Doc rebuild.
        this.applyFinalText(docId, finalText)
      }
    ).catch((err) => {
      log.appendLine(`[yjsBridge] conflictManager error: ${err} — falling back to server state`)
      const currentEntry = this.docs.get(docId)
      if (currentEntry) {
        const serverData = currentEntry.conflictServerDoc
          ? Y.encodeStateAsUpdate(currentEntry.conflictServerDoc)
          : serverStateData
        currentEntry.conflictServerDoc?.destroy()
        currentEntry.conflictServerDoc = null
        currentEntry.conflictOriginalServerText = null
        currentEntry.pendingConflict = false
        this.applyServerState(currentEntry, docId, serverData)
      }
    })
  }

  /**
   * Apply a resolved (merged) text to the Y.Doc and push the delta to the server.
   *
   * Uses the shadow conflictServerDoc (which has been kept up-to-date with every
   * WS_BINARY_YJS_STATE / WS_BINARY_YJS_UPDATE that arrived during the conflict) as
   * the server baseline.
   *
   * If the server changed since the conflict started AND the user's resolution doesn't
   * match the new server state, we restart the conflict so the user can reconcile their
   * choice against the current server content (prevents last-write-wins races when two
   * users resolve conflicts simultaneously).
   *
   * If there is no divergence between the user's choice and the latest server state,
   * we rebuild the Y.Doc from the latest server baseline and send a delta only if needed.
   *
   * pendingConflict stays true throughout and is only cleared at the very end so that
   * any WS_BINARY_YJS_STATE arriving mid-rebuild is absorbed by conflictServerDoc, not
   * re-triggering the conflict flow. The editor already shows finalText (the user just
   * resolved it) so applyDocToEditor is not needed.
   *
   * docId is resolved to the CURRENT entry from this.docs, handling the close/reopen
   * (resume) case where the original closure's entry object may be stale.
   */
  private applyFinalText(docId: string, finalText: string): void {
    const entry = this.docs.get(docId)
    if (!entry || !entry.conflictServerDoc) {
      log.appendLine(`[yjsBridge] applyFinalText: no active entry/conflictServerDoc for docId=${docId} — dropped`)
      return
    }

    const latestServerText = entry.conflictServerDoc.getText("content").toString()
    const serverChanged = latestServerText !== (entry.conflictOriginalServerText ?? "")

    if (serverChanged && finalText !== latestServerText) {
      // Another client changed the server while this user was resolving.
      // Restart the conflict: user's chosen text as "local", new server text as "remote".
      const latestServerData = Y.encodeStateAsUpdate(entry.conflictServerDoc)
      entry.conflictServerDoc.destroy()
      entry.conflictServerDoc = null
      entry.conflictOriginalServerText = null
      // pendingConflict stays true — offerReconnectChoice will start a new conflict
      log.appendLine(`[yjsBridge] server changed during conflict resolution for ${path.basename(entry.filePath)} — restarting`)
      this.offerReconnectChoice(entry, docId, latestServerData, finalText, latestServerText)
      return
    }

    // Proceed: build a fresh Y.Doc from the latest server baseline.
    const latestServerData = Y.encodeStateAsUpdate(entry.conflictServerDoc)
    entry.conflictServerDoc.destroy()
    entry.conflictServerDoc = null
    entry.conflictOriginalServerText = null

    const oldHandler = this.updateHandlers.get(docId)
    if (oldHandler) entry.yDoc.off("update", oldHandler)
    entry.yDoc.destroy()

    const freshDoc = new Y.Doc()
    Y.applyUpdate(freshDoc, latestServerData, "remote")
    entry.yDoc = freshDoc

    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return
      const frame = buildBinaryFrame(WS_BINARY_YJS_UPDATE, docId, update)
      this.wsManager.sendBinary(frame)
    }
    this.updateHandlers.set(docId, handler)
    freshDoc.on("update", handler)

    // Apply the user's resolution as TARGETED operations (not delete-all + insert).
    // By only touching the changed region (common-prefix / common-suffix diff), we allow
    // Yjs to CRDT-merge concurrent edits to non-overlapping parts of the document on the
    // server — preventing a full overwrite of another user's simultaneous changes.
    const yText = freshDoc.getText("content")
    const baseText = yText.toString()  // = latestServerText

    if (baseText !== finalText) {
      // Find the common prefix and suffix to narrow the edit to the changed middle only.
      let prefixLen = 0
      const minLen = Math.min(baseText.length, finalText.length)
      while (prefixLen < minLen && baseText[prefixLen] === finalText[prefixLen]) prefixLen++

      let suffixLen = 0
      const maxSuffix = minLen - prefixLen
      while (
        suffixLen < maxSuffix &&
        baseText[baseText.length - 1 - suffixLen] === finalText[finalText.length - 1 - suffixLen]
      ) suffixLen++

      const deleteStart = prefixLen
      const deleteLen   = baseText.length  - prefixLen - suffixLen
      const insertText  = suffixLen > 0 ? finalText.slice(prefixLen, finalText.length - suffixLen) : finalText.slice(prefixLen)

      freshDoc.transact(() => {
        if (deleteLen > 0) yText.delete(deleteStart, deleteLen)
        if (insertText.length > 0) yText.insert(deleteStart, insertText)
      })
    }

    // Drain any frames that were buffered during the conflict tail window
    // (between conflictServerDoc destroy and pendingConflict clear). Must happen
    // BEFORE clearing the flag — otherwise a concurrent handleBinaryFrame could
    // mistake the doc for "normal mode" and step on the drain. Today the drain
    // is almost always empty (the window is zero ticks in sync code), but it
    // means future async refactors can't silently drop updates.
    if (entry.conflictBufferedFrames && entry.conflictBufferedFrames.length > 0) {
      for (const bufferedData of entry.conflictBufferedFrames) {
        try {
          Y.applyUpdate(entry.yDoc, bufferedData, "remote")
        } catch (err) {
          log.appendLine(`[yjsBridge] buffered frame replay error: ${err}`)
        }
      }
      log.appendLine(`[yjsBridge] drained ${entry.conflictBufferedFrames.length} buffered conflict-tail frame(s) for ${path.basename(entry.filePath)}`)
      entry.conflictBufferedFrames = null
      this.applyDocToEditor(entry)
    }

    // Resolution is complete. Clear the gate so normal incremental updates resume.
    // Any concurrent server changes will arrive as WS_BINARY_YJS_UPDATE frames and
    // be applied normally — no re-subscribe needed (and it would race against the
    // fire-and-forget persistUpdate on the server, causing a spurious new conflict).
    entry.pendingConflict = false
    entry.hasReceivedState = true
    log.appendLine(`[yjsBridge] applied final text for ${path.basename(entry.filePath)}: ${finalText.length} chars`)
  }

  /** Replace local Y.Doc with the raw server Yjs state (error / dismiss fallback). */
  private applyServerState(entry: DocEntry, docId: string, serverStateData: Uint8Array): void {
    const oldHandler = this.updateHandlers.get(docId)
    if (oldHandler) entry.yDoc.off("update", oldHandler)
    entry.yDoc.destroy()

    const freshDoc = new Y.Doc()
    Y.applyUpdate(freshDoc, serverStateData, "remote")
    entry.yDoc = freshDoc

    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return
      const frame = buildBinaryFrame(WS_BINARY_YJS_UPDATE, docId, update)
      this.wsManager.sendBinary(frame)
    }
    this.updateHandlers.set(docId, handler)
    freshDoc.on("update", handler)

    entry.hasReceivedState = true
    log.appendLine(`[yjsBridge] applied server state for ${path.basename(entry.filePath)}`)
    this.applyDocToEditor(entry)
  }

  /**
   * Non-blocking conflict notification for background docs (not open in an editor).
   * Remote content is already written to disk — offer to open the file and resolve inline.
   */
  private offerBackgroundConflictResolution(bgEntry: BackgroundEntry, docId: string, savedLocal: string, remoteText: string): void {
    const fileName = path.basename(bgEntry.filePath)

    vscode.window.showWarningMessage(
      `Shynkro: "${fileName}" has a sync conflict (modified offline and on server).`,
      "Open to Resolve",
      "Keep Remote"
    ).then((choice) => {
      if (choice === "Keep Remote") {
        // Remote already applied to disk — nothing to do
        return
      }
      if (choice === "Open to Resolve") {
        Promise.resolve(
          vscode.workspace.openTextDocument(bgEntry.filePath)
        ).then((doc) => vscode.window.showTextDocument(doc))
          .then((editor) => {
            this.conflictManager.startConflict(docId, editor, savedLocal, remoteText, (finalText) => {
              const yText = bgEntry.yDoc.getText("content")
              bgEntry.yDoc.transact(() => {
                if (yText.length > 0) yText.delete(0, yText.length)
                if (finalText.length > 0) yText.insert(0, finalText)
              })
              this.scheduleBackgroundWrite(docId, bgEntry)
            }).catch(() => {})
          }).catch(() => {})
      }
    })
  }

  private scheduleBackgroundWrite(docId: string, entry: BackgroundEntry): void {
    if (entry.writeTimer) clearTimeout(entry.writeTimer)
    entry.writeTimer = setTimeout(() => {
      entry.writeTimer = null
      // Don't write if the file was deleted — prevents re-creating deleted files on reconnect
      const relPath = path.relative(this.workspaceRoot, entry.filePath).replace(/\\/g, "/")
      const row = this.stateDb.getFileByPath(relPath)
      if (!row) {
        log.appendLine(`[yjsBridge] skipping background write for deleted file ${path.basename(entry.filePath)}`)
        this.backgroundDocs.delete(docId)
        return
      }
      const lfText = entry.yDoc.getText("content").toString()
      const eol = (row.eolStyle ?? defaultEol()) as "lf" | "crlf"
      const bom = !!row.hasBom
      const encoded = encodeTextForDisk(lfText, eol, bom)
      try {
        this.fileWatcher.addWriteTag(entry.filePath)
        atomicWriteFileSync(entry.filePath, encoded, { encoding: "utf-8" })
        log.appendLine(`[yjsBridge] background wrote ${path.basename(entry.filePath)} (${lfText.length} chars, eol=${eol}${bom ? ", bom" : ""})`)
      } catch (err) {
        log.appendLine(`[yjsBridge] background write error for ${path.basename(entry.filePath)}: ${err}`)
      }
    }, 300)
  }

  /** Find the current live editor for a file path, or null. */
  private findEditorForFile(filePath: string): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.scheme === "file" && e.document.uri.fsPath === filePath
    )
  }

  private async applyDocToEditor(entry: DocEntry, retries = 3, onSuccess?: () => void): Promise<void> {
    if (entry.pendingConflict) { onSuccess?.(); return }
    const lfText = entry.yDoc.getText("content").toString()

    // Refresh editor reference if the old one is dead
    const liveEditor = this.findEditorForFile(entry.filePath)
    if (liveEditor) entry.editor = liveEditor

    // If no live editor, try to open the document directly
    let doc = entry.editor.document
    if (doc.isClosed) {
      try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.filePath))
      } catch {
        log.appendLine(`[yjsBridge] applyDocToEditor: can't open ${path.basename(entry.filePath)}`)
        onSuccess?.()
        return
      }
    }
    // Expand canonical LF text to whatever EOL the editor's document uses, so we
    // never insert mixed line endings into a CRLF buffer.
    const editorText = doc.eol === vscode.EndOfLine.CRLF ? fromLf(lfText, "crlf") : lfText
    if (doc.getText() === editorText) {
      onSuccess?.()
      return
    }

    // Use WorkspaceEdit — works even if the TextEditor object is stale
    entry.applyingRemote++
    const edit = new vscode.WorkspaceEdit()
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    edit.replace(doc.uri, fullRange, editorText)
    const ok = await vscode.workspace.applyEdit(edit)
    entry.applyingRemote--
    if (ok) {
      onSuccess?.()
    } else if (retries > 0) {
      setTimeout(() => this.applyDocToEditor(entry, retries - 1, onSuccess), 50)
    } else {
      log.appendLine(`[yjsBridge] applyDocToEditor failed after retries for ${path.basename(entry.filePath)}`)
      onSuccess?.()
    }
  }

  private handleDocClose(doc: vscode.TextDocument): void {
    for (const [docId, entry] of this.docs) {
      if (entry.editor.document !== doc) continue
      // Signal cursor removal to all peers before demoting
      this.sendCursorClear(docId)
      // Suspend any pending conflict — preserve state so it can resume when file reopens
      if (entry.pendingConflict) {
        this.conflictManager.suspend(docId)
        // The shadow tracking doc can't be maintained in background — destroy it.
        // If the server changes while suspended, the resumed conflict will just show the
        // original server text vs the user's local text (acceptable trade-off).
        entry.conflictServerDoc?.destroy()
        entry.conflictServerDoc = null
        entry.conflictOriginalServerText = null
        // Keep pendingConflict true on the background entry so incoming Yjs updates stay blocked
      }
      // Demote to background — keep the Y.Doc state, continue receiving updates
      this.docs.delete(docId)
      this.backgroundDocs.set(docId, {
        yDoc: entry.yDoc,
        filePath: entry.filePath,
        workspaceId: entry.workspaceId,
        writeTimer: null,
        hasReceivedState: entry.hasReceivedState,
        pendingConflict: entry.pendingConflict,
      })
      log.appendLine(`[yjsBridge] editor closed, demoted to background: ${path.basename(entry.filePath)}`)
      return
    }
  }

  private handleLocalEdit(e: vscode.TextDocumentChangeEvent): void {
    for (const [, entry] of this.docs) {
      if (entry.editor.document !== e.document) continue
      if (entry.applyingRemote > 0) return
      if (!entry.hasReceivedState) return
      if (entry.pendingConflict) return

      if (this.currentRole === "viewer") {
        this.showPermissionRequestPopup(entry.workspaceId)
        // Restore editor from Yjs truth — debounced to handle rapid typing.
        // Using applyDocToEditor (not `undo`) avoids undo-stack entanglement:
        // `undo` could traverse past a prior server sync and restore stuck viewer edits.
        if (this.viewerResyncTimer) clearTimeout(this.viewerResyncTimer)
        this.viewerResyncTimer = setTimeout(() => {
          this.viewerResyncTimer = null
          this.applyDocToEditor(entry)
        }, 50)
        return
      }

      // VS Code surfaces change.rangeOffset / change.rangeLength in *editor*
      // coordinates — i.e. with `\r\n` counted as 2 chars when the document EOL
      // is CRLF. The Y.Doc holds canonical LF text, so we translate offsets
      // before applying. Snapshotting editorTextBefore once per event keeps the
      // translation stable across multiple changes (and matches the order they
      // were produced — sorted descending by offset, which is the existing
      // contract that lets multi-edit changes apply without re-numbering).
      const isCrlf = e.document.eol === vscode.EndOfLine.CRLF
      const editorTextBefore = isCrlf ? e.document.getText() : ""
      const yText = entry.yDoc.getText("content")
      entry.yDoc.transact(() => {
        const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset)
        for (const change of changes) {
          let lfOffset: number
          let lfLength: number
          let lfText: string
          if (isCrlf) {
            lfOffset = editorOffsetToLfOffset(editorTextBefore, change.rangeOffset)
            lfLength = change.rangeLength - countCrInRange(editorTextBefore, change.rangeOffset, change.rangeLength)
            lfText = toLf(change.text)
          } else {
            lfOffset = change.rangeOffset
            lfLength = change.rangeLength
            lfText = change.text
          }
          if (lfLength > 0) yText.delete(lfOffset, lfLength)
          if (lfText.length > 0) yText.insert(lfOffset, lfText)
        }
      })
      return // Only apply to the first matching doc entry
    }
  }

  private showPermissionRequestPopup(workspaceId: WorkspaceId): void {
    if (this.permissionPopupShown) return
    this.permissionPopupShown = true
    vscode.window.showWarningMessage(
      "You are a viewer and cannot edit this file. Request editor access?",
      "Request Access"
    ).then((choice) => {
      if (choice === "Request Access") {
        this.wsManager.sendJson({ type: "requestPermission", workspaceId })
      }
    })
  }

  private sendCursorUpdate(docId: string, entry: DocEntry, selection: vscode.Selection): void {
    if (!this.wsManager.connected) return
    const payload: CursorPayload = {
      userId: this.wsManager.userId,
      username: this.username,
      cursor: { line: selection.active.line, character: selection.active.character },
      selection: selection.isEmpty ? null : {
        anchor: { line: selection.anchor.line, character: selection.anchor.character },
        active:  { line: selection.active.line, character: selection.active.character },
      },
    }
    const data = Buffer.from(JSON.stringify(payload)).toString("base64")
    this.wsManager.sendJson({ type: "awarenessUpdate", docId: docId as DocId, data })
  }

  private sendCursorClear(docId: string): void {
    if (!this.wsManager.connected) return
    const payload: CursorPayload = {
      userId: this.wsManager.userId,
      username: this.username,
      cursor: null,
      selection: null,
    }
    const data = Buffer.from(JSON.stringify(payload)).toString("base64")
    this.wsManager.sendJson({ type: "awarenessUpdate", docId: docId as DocId, data })
  }

  private getOrCreateCursorState(userId: string, username: string): RemoteCursorState {
    const existing = this.remoteCursors.get(userId)
    if (existing) return existing
    const color = CURSOR_COLORS[this.remoteCursors.size % CURSOR_COLORS.length]
    const cursorDecoration = vscode.window.createTextEditorDecorationType({
      borderStyle: "solid",
      borderColor: color,
      borderWidth: "0 0 0 2px",
    })
    const labelAboveDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: ` ${username} `,
        backgroundColor: color,
        color: "#ffffff",
        fontWeight: "bold",
        fontStyle: "normal",
        textDecoration: "none; position: absolute; top: -1.35em; z-index: 1; white-space: nowrap; border-radius: 3px; padding: 0 2px;",
      },
    })
    const labelBelowDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: ` ${username} `,
        backgroundColor: color,
        color: "#ffffff",
        fontWeight: "bold",
        fontStyle: "normal",
        textDecoration: "none; position: absolute; top: 1.35em; z-index: 1; white-space: nowrap; border-radius: 3px; padding: 0 2px;",
      },
    })
    const selectionDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: color + "33",
    })
    const state: RemoteCursorState = {
      color, cursorDecoration, labelAboveDecoration, labelBelowDecoration, selectionDecoration,
      expiryTimer: null, activeEditor: null,
    }
    this.remoteCursors.set(userId, state)
    return state
  }

  private applyRemoteCursor(docId: string, entry: DocEntry, payload: CursorPayload): void {
    const state = this.getOrCreateCursorState(payload.userId, payload.username)

    // Always use the freshest live editor for this doc
    const liveEditor = this.findEditorForFile(entry.filePath) ?? entry.editor

    // Reset 5-second expiry (clears decorations if user disconnects silently)
    if (state.expiryTimer) clearTimeout(state.expiryTimer)
    if (payload.cursor !== null) {
      state.expiryTimer = setTimeout(() => {
        state.expiryTimer = null
        if (state.activeEditor) {
          state.activeEditor.setDecorations(state.cursorDecoration, [])
          state.activeEditor.setDecorations(state.labelAboveDecoration, [])
          state.activeEditor.setDecorations(state.labelBelowDecoration, [])
          state.activeEditor.setDecorations(state.selectionDecoration, [])
          state.activeEditor = null
        }
      }, 5000)
    }

    // Clear from old editor if user moved to a different doc
    if (state.activeEditor && state.activeEditor.document.uri.fsPath !== liveEditor.document.uri.fsPath) {
      state.activeEditor.setDecorations(state.cursorDecoration, [])
      state.activeEditor.setDecorations(state.labelAboveDecoration, [])
      state.activeEditor.setDecorations(state.labelBelowDecoration, [])
      state.activeEditor.setDecorations(state.selectionDecoration, [])
    }

    if (payload.cursor === null) {
      if (state.activeEditor) {
        state.activeEditor.setDecorations(state.cursorDecoration, [])
        state.activeEditor.setDecorations(state.labelAboveDecoration, [])
        state.activeEditor.setDecorations(state.labelBelowDecoration, [])
        state.activeEditor.setDecorations(state.selectionDecoration, [])
        state.activeEditor = null
      }
      return
    }

    state.activeEditor = liveEditor

    // Apply cursor decoration (thin left border at cursor position)
    const cursorPos = new vscode.Position(payload.cursor.line, payload.cursor.character)
    liveEditor.setDecorations(state.cursorDecoration, [new vscode.Range(cursorPos, cursorPos)])

    // Line 0: nothing above the viewport — show label below instead
    if (this.hiddenLabels.has(payload.userId)) {
      liveEditor.setDecorations(state.labelAboveDecoration, [])
      liveEditor.setDecorations(state.labelBelowDecoration, [])
    } else if (payload.cursor.line === 0) {
      liveEditor.setDecorations(state.labelAboveDecoration, [])
      liveEditor.setDecorations(state.labelBelowDecoration, [new vscode.Range(cursorPos, cursorPos)])
    } else {
      liveEditor.setDecorations(state.labelBelowDecoration, [])
      liveEditor.setDecorations(state.labelAboveDecoration, [new vscode.Range(cursorPos, cursorPos)])
    }

    // Apply selection decoration
    if (payload.selection) {
      const selRange = new vscode.Range(
        new vscode.Position(payload.selection.anchor.line, payload.selection.anchor.character),
        new vscode.Position(payload.selection.active.line,  payload.selection.active.character),
      )
      liveEditor.setDecorations(state.selectionDecoration, [selRange])
    } else {
      liveEditor.setDecorations(state.selectionDecoration, [])
    }

    log.appendLine(`[yjsBridge] cursor ${payload.username} → ${payload.cursor.line}:${payload.cursor.character} in ${path.basename(entry.filePath)}`)
  }

  startFollowing(userId: string): void {
    this.followingUserId = userId
    this.lastFollowedDocId = null
  }

  stopFollowing(): void {
    this.followingUserId = null
    this.lastFollowedDocId = null
  }

  get followedUserId(): string | null { return this.followingUserId }

  private applyFollowNavigation(docId: string, filePath: string, payload: CursorPayload): void {
    if (!payload.cursor) return
    const pos = new vscode.Position(payload.cursor.line, payload.cursor.character)
    const range = new vscode.Range(pos, pos)

    if (docId !== this.lastFollowedDocId) {
      this.lastFollowedDocId = docId
      ;(async () => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
        const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Active })
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
      })().catch(() => {})
    } else {
      const editor = this.findEditorForFile(filePath)
      if (editor) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
      }
    }
  }

  setLabelHidden(userId: string, hidden: boolean): void {
    if (hidden) {
      this.hiddenLabels.add(userId)
    } else {
      this.hiddenLabels.delete(userId)
    }
    const state = this.remoteCursors.get(userId)
    if (state?.activeEditor) {
      state.activeEditor.setDecorations(state.labelAboveDecoration, [])
      state.activeEditor.setDecorations(state.labelBelowDecoration, [])
    }
  }

  dispose(): void {
    if (this.viewerResyncTimer) { clearTimeout(this.viewerResyncTimer); this.viewerResyncTimer = null }
    for (const [docId, entry] of this.docs) {
      this.wsManager.sendJson({ type: "unsubscribeDoc", docId: docId as DocId })
      entry.yDoc.destroy()
      entry.conflictServerDoc?.destroy()
    }
    for (const [docId, bgEntry] of this.backgroundDocs) {
      this.wsManager.sendJson({ type: "unsubscribeDoc", docId: docId as DocId })
      if (bgEntry.writeTimer) clearTimeout(bgEntry.writeTimer)
      bgEntry.yDoc.destroy()
    }
    for (const timer of this.selectionTimers.values()) clearTimeout(timer)
    this.selectionTimers.clear()
    for (const state of this.remoteCursors.values()) {
      if (state.expiryTimer) clearTimeout(state.expiryTimer)
      state.cursorDecoration.dispose()
      state.labelAboveDecoration.dispose()
      state.labelBelowDecoration.dispose()
      state.selectionDecoration.dispose()
    }
    this.remoteCursors.clear()
    this.docs.clear()
    this.backgroundDocs.clear()
    this.viewerStatusBarItem?.dispose()
    this.viewerStatusBarItem = null
    this.disposables.forEach((d) => d.dispose())
  }
}
