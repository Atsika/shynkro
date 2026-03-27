import * as path from "path"
import * as vscode from "vscode"
import { buildConflictText } from "./diffUtils"
import { log } from "../logger"

interface ActiveConflict {
  docUri: string
  filePath: string
  localText: string
  serverText: string
  listener: vscode.Disposable
  onResolved: (finalText: string) => void
  /** True while we are writing the conflict markers — prevents self-triggering. */
  writing: boolean
}

interface SuspendedConflict {
  filePath: string
  localText: string
  serverText: string
  onResolved: (finalText: string) => void
}

/**
 * Manages inline sync conflict resolution.
 *
 * Lifecycle:
 *  startConflict()  — injects git-style markers into the editor buffer (not disk),
 *                     monitors until all markers are resolved, then calls onResolved.
 *  suspend()        — called when the conflicted file is closed; preserves state so
 *                     the conflict can be resumed when the file is reopened.
 *  resume()         — re-injects markers when a suspended file is opened again.
 *  clear()          — permanently cancels a conflict (e.g. on stopSync).
 */
export class ConflictManager implements vscode.Disposable {
  private readonly active    = new Map<string, ActiveConflict>()
  private readonly suspended = new Map<string, SuspendedConflict>()
  private readonly onCountChange: (n: number) => void
  private readonly _onListChanged = new vscode.EventEmitter<void>()
  readonly onListChanged = this._onListChanged.event

  constructor(onCountChange: (n: number) => void) {
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
   * Writes conflict markers into the editor buffer and waits for the user to resolve.
   */
  async startConflict(
    docId: string,
    editor: vscode.TextEditor,
    localText: string,
    serverText: string,
    onResolved: (finalText: string) => void
  ): Promise<void> {
    // Cancel any prior active conflict for this doc (do NOT clear suspended — resume path)
    this.cancelActive(docId)

    const conflictText = buildConflictText(localText, serverText)
    if (conflictText === localText) {
      onResolved(localText)
      return
    }

    const conflict: ActiveConflict = {
      docUri: editor.document.uri.toString(),
      filePath: editor.document.uri.fsPath,
      localText,
      serverText,
      listener: null!,
      onResolved,
      writing: true,
    }
    this.active.set(docId, conflict)
    this.onCountChange(this.count)
    this._onListChanged.fire()

    // Write conflict markers into the buffer (in memory — file not saved to disk)
    const doc = editor.document
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    const edit = new vscode.WorkspaceEdit()
    edit.replace(doc.uri, fullRange, conflictText)
    await vscode.workspace.applyEdit(edit)

    conflict.writing = false

    // Ensure the document is visible
    await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false })

    // Watch for resolution: all <<<<<<< markers gone
    conflict.listener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== conflict.docUri) return
      if (conflict.writing) return
      if (!e.document.getText().includes("<<<<<<<")) {
        this.finalize(docId, e.document.getText())
      }
    })

    log.appendLine(`[conflictManager] started for docId=${docId} file=${path.basename(editor.document.uri.fsPath)}`)
  }

  /**
   * Suspend an active conflict when the editor is closed.
   * The conflict state is preserved so it can be resumed with resume().
   */
  suspend(docId: string): void {
    const conflict = this.active.get(docId)
    if (!conflict) return
    conflict.listener?.dispose()
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
   * Re-injects conflict markers into the new editor instance.
   */
  async resume(docId: string, editor: vscode.TextEditor): Promise<void> {
    const s = this.suspended.get(docId)
    if (!s) return
    this.suspended.delete(docId)
    // onCountChange called inside startConflict
    log.appendLine(`[conflictManager] resuming docId=${docId}`)
    await this.startConflict(docId, editor, s.localText, s.serverText, s.onResolved)
  }

  /** Permanently cancel a conflict (active or suspended) without resolving it. */
  clear(docId: string): void {
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
    this.active.delete(docId)
    this.onCountChange(this.count)
    this._onListChanged.fire()
    log.appendLine(`[conflictManager] resolved docId=${docId}`)
    conflict.onResolved(finalText)
  }

  dispose(): void {
    for (const c of this.active.values()) c.listener?.dispose()
    this.active.clear()
    this.suspended.clear()
    this._onListChanged.dispose()
  }
}
