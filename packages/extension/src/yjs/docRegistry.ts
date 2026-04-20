import * as path from "path"
import * as vscode from "vscode"
import * as Y from "yjs"
import type { CursorPayload, FileId, WorkspaceId } from "@shynkro/shared"
import { log } from "../logger"

export interface DocEntry {
  yDoc: Y.Doc
  fileId: FileId
  filePath: string
  workspaceId: WorkspaceId
  editor: vscode.TextEditor
  applyingRemote: number
  hasReceivedState: boolean
  pendingCursor: CursorPayload | null
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
