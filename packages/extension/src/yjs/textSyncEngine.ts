import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import * as Y from "yjs"
import type { Role } from "@shynkro/shared"
import type { StateDb } from "../state/stateDb"
import type { ViewerRoleUi } from "./viewerRoleUi"
import type { AwarenessController } from "./awarenessController"
import { DocRegistry, findEditorForFile, type DocEntry } from "./docRegistry"
import { editorOffsetToLfOffset, countCrInRange } from "./yjsFrames"
import { decodeTextFile, encodeTextForDisk, fromLf, toLf } from "../text/textNormalize"
import { log } from "../logger"

/**
 * Maximum size of a single Yjs insert (in characters) before it gets split into
 * multiple smaller transactions. Each transact() emits one WS frame, so capping
 * the per-transact size keeps frames well under the server's 50 MB safety net.
 */
const PASTE_CHUNK_THRESHOLD = 256 * 1024

/**
 * Bridges Y.Doc text into the live editor and vice versa: applies CRDT state
 * to a TextEditor with minimal prefix/suffix replaces, captures local edits
 * into Yjs ops (with paste-chunking), and ingests external on-disk edits.
 */
export class TextSyncEngine {
  private viewerResyncTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly registry: DocRegistry,
    private readonly awareness: AwarenessController,
    private readonly viewerUi: ViewerRoleUi,
    private readonly stateDb: StateDb,
    private readonly workspaceRoot: string,
    private readonly getRole: () => Role,
  ) {}

  /**
   * Push the Y.Doc text into its editor using a minimal prefix/suffix replace,
   * so decorations (cursors, selections) outside the changed region survive.
   */
  async applyDocToEditor(entry: DocEntry, retries = 3, onSuccess?: () => void): Promise<void> {
    const lfText = entry.yDoc.getText("content").toString()
    const liveEditor = findEditorForFile(entry.filePath)
    if (liveEditor) entry.editor = liveEditor

    let doc = entry.editor.document
    if (doc.isClosed) {
      try { doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.filePath)) }
      catch { onSuccess?.(); return }
    }
    const editorText = doc.eol === vscode.EndOfLine.CRLF ? fromLf(lfText, "crlf") : lfText
    if (doc.getText() === editorText) { onSuccess?.(); return }

    const currentText = doc.getText()
    let prefixLen = 0
    const minLen = Math.min(currentText.length, editorText.length)
    while (prefixLen < minLen && currentText[prefixLen] === editorText[prefixLen]) prefixLen++
    let suffixLen = 0
    const maxSuffix = minLen - prefixLen
    while (
      suffixLen < maxSuffix &&
      currentText[currentText.length - 1 - suffixLen] === editorText[editorText.length - 1 - suffixLen]
    ) suffixLen++

    const replaceStart = doc.positionAt(prefixLen)
    const replaceEnd = doc.positionAt(currentText.length - suffixLen)
    const insertText = editorText.slice(prefixLen, suffixLen > 0 ? editorText.length - suffixLen : undefined)

    entry.applyingRemote++
    let ok: boolean
    try {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(doc.uri, new vscode.Range(replaceStart, replaceEnd), insertText)
      ok = await vscode.workspace.applyEdit(edit)
    } catch (err) {
      log.appendLine(`[yjsBridge] applyDocToEditor threw for ${path.basename(entry.filePath)}: ${err}`)
      ok = false
    } finally {
      entry.applyingRemote--
    }
    if (ok) { onSuccess?.(); this.drainPendingCursor(entry) }
    else if (retries > 0) {
      setTimeout(() => this.applyDocToEditor(entry, retries - 1, onSuccess), 50)
    } else {
      log.appendLine(`[yjsBridge] applyDocToEditor failed after retries for ${path.basename(entry.filePath)}`)
      onSuccess?.()
      this.drainPendingCursor(entry)
    }
  }

  private drainPendingCursor(entry: DocEntry): void {
    const cursor = entry.pendingCursor
    if (!cursor) return
    entry.pendingCursor = null
    if (cursor.userId !== this.awareness.selfUserId) {
      this.awareness.applyRemoteCursor(entry.filePath, entry.editor, cursor)
    }
  }

  handleLocalEdit(e: vscode.TextDocumentChangeEvent): void {
    for (const [, entry] of this.registry.docEntries()) {
      if (entry.editor.document !== e.document) continue
      if (entry.applyingRemote > 0) return
      if (this.getRole() === "viewer") {
        this.viewerUi.showPermissionRequestPopup(entry.workspaceId)
        if (this.viewerResyncTimer) clearTimeout(this.viewerResyncTimer)
        this.viewerResyncTimer = setTimeout(() => {
          this.viewerResyncTimer = null
          this.applyDocToEditor(entry).catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
        }, 50)
        return
      }

      const isCrlf = e.document.eol === vscode.EndOfLine.CRLF
      const editorTextBefore = isCrlf ? e.document.getText() : ""
      const yText = entry.yDoc.getText("content")

      type LfChange = { lfOffset: number; lfLength: number; lfText: string }
      const lfChanges: LfChange[] = [...e.contentChanges]
        .sort((a, b) => b.rangeOffset - a.rangeOffset)
        .map((change) => {
          if (isCrlf) {
            return {
              lfOffset: editorOffsetToLfOffset(editorTextBefore, change.rangeOffset),
              lfLength: change.rangeLength - countCrInRange(editorTextBefore, change.rangeOffset, change.rangeLength),
              lfText: toLf(change.text),
            }
          }
          return { lfOffset: change.rangeOffset, lfLength: change.rangeLength, lfText: change.text }
        })

      const hasOversizedInsert = lfChanges.some((c) => c.lfText.length > PASTE_CHUNK_THRESHOLD)

      if (!hasOversizedInsert) {
        entry.yDoc.transact(() => {
          for (const c of lfChanges) {
            if (c.lfLength > 0) yText.delete(c.lfOffset, c.lfLength)
            if (c.lfText.length > 0) yText.insert(c.lfOffset, c.lfText)
          }
        })
      } else {
        log.appendLine(`[yjsBridge] paste-chunking ${lfChanges.length} change(s) with oversized insert(s) for ${path.basename(entry.filePath)}`)
        for (const c of lfChanges) {
          if (c.lfLength > 0) {
            entry.yDoc.transact(() => yText.delete(c.lfOffset, c.lfLength))
          }
          if (c.lfText.length === 0) continue
          if (c.lfText.length <= PASTE_CHUNK_THRESHOLD) {
            entry.yDoc.transact(() => yText.insert(c.lfOffset, c.lfText))
            continue
          }
          for (let i = 0; i < c.lfText.length; i += PASTE_CHUNK_THRESHOLD) {
            const slice = c.lfText.slice(i, i + PASTE_CHUNK_THRESHOLD)
            const at = c.lfOffset + i
            entry.yDoc.transact(() => yText.insert(at, slice))
          }
        }
      }
      return
    }
  }

  /**
   * External tool wrote to a tracked file (vim, git, etc.). Diff into the Yjs
   * doc as prefix/suffix-aware ops so it propagates as a normal update.
   */
  handleExternalTextEdit(filePath: string, docId: string): void {
    if (this.getRole() === "viewer") return
    let rawDiskText: string
    try { rawDiskText = fs.readFileSync(filePath, "utf-8") } catch { return }
    const decoded = decodeTextFile(rawDiskText)
    const diskText = decoded.content
    const relPath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, "/")
    const row = this.stateDb.getFileByPath(relPath)
    if (row && row.eolStyle === null) {
      this.stateDb.setTextFormat(row.fileId, decoded.eol, decoded.bom)
    }

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

    const entry = this.registry.getDoc(docId)
    if (entry) {
      // Hold the suppression flag across both the Y.Text mutation and the
      // editor write-back so any keystroke that lands in this window is
      // ignored instead of being clobbered by the stale replace ranges.
      entry.applyingRemote++
      try {
        applyOps(entry.yDoc)
      } catch (err) {
        entry.applyingRemote--
        throw err
      }
      this.applyDocToEditor(entry)
        .catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
        .finally(() => { entry.applyingRemote-- })
      return
    }
    const bgEntry = this.registry.getBackground(docId)
    if (bgEntry && bgEntry.hasReceivedState) {
      applyOps(bgEntry.yDoc)
    }
  }

  dispose(): void {
    if (this.viewerResyncTimer) { clearTimeout(this.viewerResyncTimer); this.viewerResyncTimer = null }
  }
}
