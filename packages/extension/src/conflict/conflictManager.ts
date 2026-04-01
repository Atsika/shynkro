import * as path from "path"
import * as vscode from "vscode"
import { buildConflictText } from "./diffUtils"
import type { ConflictHunkMeta } from "./diffUtils"
import type { ConflictDecorations } from "./conflictDecorations"
import type { ConflictLensProvider } from "./conflictLens"
import { log } from "../logger"

interface ActiveConflict {
  docUri: string
  filePath: string
  localText: string
  serverText: string
  hunks: ConflictHunkMeta[]
  listener: vscode.Disposable
  onResolved: (finalText: string) => void
  /** True while we are writing conflict content — prevents self-triggering. */
  writing: boolean
}

interface SuspendedConflict {
  filePath: string
  localText: string
  serverText: string
  onResolved: (finalText: string) => void
}

/**
 * Manages inline sync conflict resolution with Cursor-like visual diff.
 *
 * Lifecycle:
 *  startConflict()  — injects interleaved local/server blocks with green/red
 *                     decorations and CodeLens accept/reject buttons.
 *  resolveHunk()    — resolves a single hunk (keep local or server lines).
 *  suspend()        — called when the conflicted file is closed; preserves state.
 *  resume()         — re-injects conflict when a suspended file is reopened.
 *  clear()          — permanently cancels a conflict (e.g. on stopSync).
 */
export class ConflictManager implements vscode.Disposable {
  private readonly active    = new Map<string, ActiveConflict>()
  private readonly suspended = new Map<string, SuspendedConflict>()
  private readonly onCountChange: (n: number) => void
  private readonly _onListChanged = new vscode.EventEmitter<void>()
  readonly onListChanged = this._onListChanged.event

  constructor(
    onCountChange: (n: number) => void,
    private readonly decorations: ConflictDecorations,
    private readonly lensProvider: ConflictLensProvider
  ) {
    this.onCountChange = onCountChange
  }

  get count(): number {
    return this.active.size + this.suspended.size
  }

  getConflicts(): Array<{ docId: string; filePath: string }> {
    const result: Array<{ docId: string; filePath: string }> = []
    for (const [docId, c] of this.active) result.push({ docId, filePath: c.filePath })
    for (const [docId, c] of this.suspended) result.push({ docId, filePath: c.filePath })
    return result
  }

  hasSuspended(docId: string): boolean {
    return this.suspended.has(docId)
  }

  /**
   * Start a conflict resolution session for an open document.
   * Writes interleaved local/server blocks into the editor buffer with
   * green/red decorations and CodeLens accept/reject buttons.
   */
  async startConflict(
    docId: string,
    editor: vscode.TextEditor,
    localText: string,
    serverText: string,
    onResolved: (finalText: string) => void
  ): Promise<void> {
    this.cancelActive(docId)

    const result = buildConflictText(localText, serverText)
    if (result.hunks.length === 0) {
      onResolved(localText)
      return
    }

    const conflict: ActiveConflict = {
      docUri: editor.document.uri.toString(),
      filePath: editor.document.uri.fsPath,
      localText,
      serverText,
      hunks: result.hunks,
      listener: null!,
      onResolved,
      writing: true,
    }
    this.active.set(docId, conflict)
    this.onCountChange(this.count)
    this._onListChanged.fire()

    // Write interleaved content into the buffer (in memory — file not saved to disk)
    const doc = editor.document
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, fullRange, result.text)
    await vscode.workspace.applyEdit(edit)

    conflict.writing = false

    // Apply decorations and CodeLens
    this.decorations.applyToEditor(editor, conflict.hunks)
    this.lensProvider.setHunks(conflict.docUri, docId, conflict.hunks)

    // Ensure the document is visible
    await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false })

    // No-op listener kept for future manual edit detection
    conflict.listener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== conflict.docUri) return
      if (conflict.writing) return
    })

    log.appendLine(`[conflictManager] started for docId=${docId} file=${path.basename(editor.document.uri.fsPath)} hunks=${conflict.hunks.length}`)
  }

  /**
   * Live-update the server text while a conflict is open.
   * Rebuilds the interleaved view with the new server content so the user
   * always sees the latest diff without needing to re-resolve.
   */
  async updateServerText(docId: string, newServerText: string): Promise<void> {
    const conflict = this.active.get(docId)
    if (!conflict || conflict.writing) return

    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === conflict.docUri)
    if (!editor) return

    // If the new server text matches local, the conflict is resolved automatically
    if (newServerText === conflict.localText) {
      conflict.writing = true
      const doc = editor.document
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
      const edit = new vscode.WorkspaceEdit()
      edit.replace(doc.uri, fullRange, conflict.localText)
      await vscode.workspace.applyEdit(edit)
      conflict.writing = false
      this.finalize(docId, conflict.localText)
      return
    }

    // Rebuild the interleaved conflict text with updated server content
    conflict.serverText = newServerText
    const result = buildConflictText(conflict.localText, newServerText)
    if (result.hunks.length === 0) {
      conflict.writing = true
      const doc = editor.document
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
      const edit = new vscode.WorkspaceEdit()
      edit.replace(doc.uri, fullRange, conflict.localText)
      await vscode.workspace.applyEdit(edit)
      conflict.writing = false
      this.finalize(docId, conflict.localText)
      return
    }

    conflict.writing = true
    conflict.hunks = result.hunks
    const doc = editor.document
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, fullRange, result.text)
    await vscode.workspace.applyEdit(edit)
    conflict.writing = false

    this.decorations.applyToEditor(editor, conflict.hunks)
    this.lensProvider.setHunks(conflict.docUri, docId, conflict.hunks)
    log.appendLine(`[conflictManager] live-updated server text for docId=${docId}, hunks=${conflict.hunks.length}`)
  }

  /**
   * Resolve a single hunk by keeping either local or server lines.
   */
  async resolveHunk(docId: string, hunkIndex: number, choice: "local" | "server"): Promise<void> {
    const conflict = this.active.get(docId)
    if (!conflict || conflict.writing) return

    const hunkIdx = conflict.hunks.findIndex((h) => h.hunkIndex === hunkIndex)
    if (hunkIdx === -1) return

    const hunk = conflict.hunks[hunkIdx]
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === conflict.docUri)
    if (!editor) return

    // Determine which lines to remove
    let removeStart: number
    let removeEnd: number
    if (choice === "local") {
      // Keep local (green) lines, remove server (red) lines
      removeStart = hunk.serverRange.start
      removeEnd = hunk.serverRange.end
    } else {
      // Keep server (red) lines, remove local (green) lines
      removeStart = hunk.localRange.start
      removeEnd = hunk.localRange.end
    }

    const linesRemoved = removeEnd - removeStart

    conflict.writing = true
    const wsEdit = new vscode.WorkspaceEdit()
    const range = new vscode.Range(removeStart, 0, removeEnd, 0)
    wsEdit.delete(editor.document.uri, range)
    await vscode.workspace.applyEdit(wsEdit)
    conflict.writing = false

    // Remove resolved hunk and shift subsequent hunk positions
    conflict.hunks.splice(hunkIdx, 1)
    for (const h of conflict.hunks) {
      if (h.localRange.start > removeStart) {
        h.localRange.start -= linesRemoved
        h.localRange.end -= linesRemoved
        h.serverRange.start -= linesRemoved
        h.serverRange.end -= linesRemoved
      }
    }

    if (conflict.hunks.length === 0) {
      this.finalize(docId, editor.document.getText())
    } else {
      // Re-apply decorations and update CodeLens
      this.decorations.applyToEditor(editor, conflict.hunks)
      this.lensProvider.setHunks(conflict.docUri, docId, conflict.hunks)
    }

    log.appendLine(`[conflictManager] resolved hunk ${hunkIndex} (${choice}) for docId=${docId}, remaining=${conflict.hunks.length}`)
  }

  /**
   * Find which hunk the cursor is in and resolve it.
   * Used when triggered via keyboard shortcut (no args).
   */
  resolveHunkAtCursor(docId: string | undefined, choice: "local" | "server"): void {
    const editor = vscode.window.activeTextEditor
    if (!editor) return

    let targetDocId = docId
    if (!targetDocId) {
      for (const [id, c] of this.active) {
        if (c.docUri === editor.document.uri.toString()) { targetDocId = id; break }
      }
    }
    if (!targetDocId) return

    const conflict = this.active.get(targetDocId)
    if (!conflict) return

    const cursorLine = editor.selection.active.line
    const hunk = conflict.hunks.find(
      (h) => cursorLine >= h.localRange.start && cursorLine < h.serverRange.end
    )
    if (hunk) {
      this.resolveHunk(targetDocId, hunk.hunkIndex, choice).catch(() => {})
    }
  }

  /**
   * Suspend an active conflict when the editor is closed.
   */
  suspend(docId: string): void {
    const conflict = this.active.get(docId)
    if (!conflict) return
    conflict.listener?.dispose()
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === conflict.docUri)
    if (editor) this.decorations.clearFromEditor(editor)
    this.lensProvider.removeDoc(conflict.docUri)
    this.active.delete(docId)
    this.suspended.set(docId, {
      filePath: conflict.filePath,
      localText: conflict.localText,
      serverText: conflict.serverText,
      onResolved: conflict.onResolved,
    })
    this.onCountChange(this.count)
    this._onListChanged.fire()
    log.appendLine(`[conflictManager] suspended docId=${docId}`)
  }

  /**
   * Resume a suspended conflict when the file is reopened.
   */
  async resume(docId: string, editor: vscode.TextEditor): Promise<void> {
    const s = this.suspended.get(docId)
    if (!s) return
    this.suspended.delete(docId)
    log.appendLine(`[conflictManager] resuming docId=${docId}`)
    await this.startConflict(docId, editor, s.localText, s.serverText, s.onResolved)
  }

  /** Permanently cancel a conflict (active or suspended) without resolving it. */
  clear(docId: string): void {
    const conflict = this.active.get(docId)
    if (conflict) {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === conflict.docUri)
      if (editor) this.decorations.clearFromEditor(editor)
      this.lensProvider.removeDoc(conflict.docUri)
    }
    this.cancelActive(docId)
    this.suspended.delete(docId)
    this.onCountChange(this.count)
    this._onListChanged.fire()
  }

  private cancelActive(docId: string): void {
    const conflict = this.active.get(docId)
    if (!conflict) return
    conflict.listener?.dispose()
    this.active.delete(docId)
  }

  private finalize(docId: string, finalText: string): void {
    const conflict = this.active.get(docId)
    if (!conflict) return
    conflict.listener.dispose()
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === conflict.docUri)
    if (editor) this.decorations.clearFromEditor(editor)
    this.lensProvider.removeDoc(conflict.docUri)
    this.active.delete(docId)
    this.onCountChange(this.count)
    this._onListChanged.fire()
    log.appendLine(`[conflictManager] resolved docId=${docId}`)
    conflict.onResolved(finalText)
  }

  dispose(): void {
    for (const c of this.active.values()) {
      c.listener?.dispose()
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === c.docUri)
      if (editor) this.decorations.clearFromEditor(editor)
      this.lensProvider.removeDoc(c.docUri)
    }
    this.active.clear()
    this.suspended.clear()
    this._onListChanged.dispose()
  }
}
