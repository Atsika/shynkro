import * as path from "path"
import * as vscode from "vscode"
import * as Y from "yjs"
import type { CursorPayload, FileId, WorkspaceId } from "@shynkro/shared"
import { log } from "../logger"

/**
 * Signature of the next programmatic `applyEdit` we expect VS Code to fire
 * onto the doc. `handleLocalEdit` consumes the matching contentChange so it
 * is not round-tripped back into the Y.Doc as a duplicate user edit, and
 * processes any additional changes in the same event as real user input.
 *
 * `expiresAt` is a safety net: if the event never fires (applyEdit rejected,
 * no-op collapse, etc.) the fence lifts automatically after 500 ms so real
 * user keystrokes aren't held hostage forever.
 */
export interface PendingEditorWrite {
  change: { rangeOffset: number; rangeLength: number; text: string }
  expiresAt: number
}

export interface DocEntry {
  yDoc: Y.Doc
  fileId: FileId
  filePath: string
  workspaceId: WorkspaceId
  editor: vscode.TextEditor
  /**
   * Counter held only across synchronous remote Y.Doc mutations — currently
   * the brief window between `fs.readFileSync` and `applyOps` in
   * `handleExternalTextEdit`. Not held across async editor writes (that is
   * what `pendingEditorWrite` is for), which is the fix for D4: user
   * keystrokes during the async `applyEdit` no longer disappear.
   */
  applyingRemote: number
  pendingEditorWrite: PendingEditorWrite | null
  /**
   * Serializes concurrent `applyDocToEditor` calls for this doc so back-to-back
   * remote frames cannot overwrite each other's `pendingEditorWrite` signature.
   * Each call chains `.then(...)` onto the previous one and reassigns this
   * field. Initialized to `Promise.resolve()`.
   */
  applyChain: Promise<void>
  hasReceivedState: boolean
  pendingCursor: CursorPayload | null
  /**
   * True when the user chose "Keep" after a recovery-copy write failed on a
   * remote delete. While set, outbound local updates are suppressed, inbound
   * state/update frames are ignored, and background disk writes skip —
   * nothing ships until the user explicitly exits recovery mode via the
   * `shynkro.exitRecovery` command.
   */
  recoveryMode: boolean
}

export interface BackgroundEntry {
  yDoc: Y.Doc
  filePath: string
  workspaceId: WorkspaceId
  writeTimer: ReturnType<typeof setTimeout> | null
  hasReceivedState: boolean
}

type UpdateHandler = (update: Uint8Array, origin: unknown) => void

/**
 * Owns the foreground/background doc maps and the per-doc update handler
 * registry. Encapsulates lookup, mutation, and stale-entry eviction so the
 * bridge does not have to manage these maps directly.
 */
export class DocRegistry {
  private readonly docs = new Map<string, DocEntry>()
  private readonly backgroundDocs = new Map<string, BackgroundEntry>()
  private readonly updateHandlers = new Map<string, UpdateHandler>()

  getDoc(docId: string): DocEntry | undefined { return this.docs.get(docId) }
  getBackground(docId: string): BackgroundEntry | undefined { return this.backgroundDocs.get(docId) }
  hasDoc(docId: string): boolean { return this.docs.has(docId) }
  hasBackground(docId: string): boolean { return this.backgroundDocs.has(docId) }
  setDoc(docId: string, entry: DocEntry): void { this.docs.set(docId, entry) }
  setBackground(docId: string, entry: BackgroundEntry): void { this.backgroundDocs.set(docId, entry) }
  deleteDoc(docId: string): void { this.docs.delete(docId) }
  deleteBackground(docId: string): void { this.backgroundDocs.delete(docId) }

  setHandler(docId: string, handler: UpdateHandler): void { this.updateHandlers.set(docId, handler) }
  getHandler(docId: string): UpdateHandler { return this.updateHandlers.get(docId) ?? (() => {}) }
  deleteHandler(docId: string): void { this.updateHandlers.delete(docId) }

  docEntries(): IterableIterator<[string, DocEntry]> { return this.docs.entries() }
  backgroundEntries(): IterableIterator<[string, BackgroundEntry]> { return this.backgroundDocs.entries() }
  docValues(): IterableIterator<DocEntry> { return this.docs.values() }

  findDocIdForPath(fsPath: string): string | null {
    for (const [docId, entry] of this.docs) {
      if (entry.filePath === fsPath) return docId
    }
    return null
  }

  findDocIdForEntry(entry: DocEntry): string | null {
    for (const [docId, e] of this.docs) {
      if (e === entry) return docId
    }
    return null
  }

  /**
   * Drop any prior foreground/background entries that point at the same file
   * path but a different docId — happens after a clone/rename round-trips
   * through a new file id.
   */
  evictStaleEntriesForPath(filePath: string, exceptDocId: string): void {
    for (const [oldDocId, oldEntry] of this.docs) {
      if (oldEntry.filePath !== filePath || oldDocId === exceptDocId) continue
      log.appendLine(`[yjsBridge] evicting stale doc entry ${oldDocId} for ${path.basename(filePath)}`)
      const h = this.updateHandlers.get(oldDocId)
      if (h) { oldEntry.yDoc.off("update", h); this.updateHandlers.delete(oldDocId) }
      oldEntry.yDoc.destroy()
      this.docs.delete(oldDocId)
    }
    for (const [oldDocId, oldBg] of this.backgroundDocs) {
      if (oldBg.filePath !== filePath || oldDocId === exceptDocId) continue
      log.appendLine(`[yjsBridge] evicting stale background entry ${oldDocId} for ${path.basename(filePath)}`)
      if (oldBg.writeTimer) clearTimeout(oldBg.writeTimer)
      const h = this.updateHandlers.get(oldDocId)
      if (h) { oldBg.yDoc.off("update", h); this.updateHandlers.delete(oldDocId) }
      oldBg.yDoc.destroy()
      this.backgroundDocs.delete(oldDocId)
    }
  }

  clear(): void {
    this.docs.clear()
    this.backgroundDocs.clear()
    this.updateHandlers.clear()
  }
}

export function findEditorForFile(filePath: string): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.scheme === "file" && e.document.uri.fsPath === filePath,
  )
}
