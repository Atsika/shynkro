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
   *
   * Sets `entry.pendingEditorWrite` BEFORE `applyEdit` so the resulting
   * `onDidChangeTextDocument` event is consumed by `handleLocalEdit` rather
   * than round-tripped into the Y.Doc as a duplicate user edit. The fence is
   * NOT a broad "applyingRemote" counter — a real user keystroke arriving
   * during the async `applyEdit` window is still processed into Y.Doc (the
   * fix for D4). See {@link handleLocalEdit} for the matching logic.
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

    entry.pendingEditorWrite = {
      change: {
        rangeOffset: prefixLen,
        rangeLength: currentText.length - prefixLen - suffixLen,
        text: insertText,
      },
      expiresAt: Date.now() + 500,
    }
    let ok: boolean
    try {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(doc.uri, new vscode.Range(replaceStart, replaceEnd), insertText)
      ok = await vscode.workspace.applyEdit(edit)
    } catch (err) {
      log.appendLine(`[yjsBridge] applyDocToEditor threw for ${path.basename(entry.filePath)}: ${err}`)
      ok = false
    }
    // Do NOT clear pendingEditorWrite here — the event fires asynchronously
    // via VS Code's event loop. handleLocalEdit clears it on match; the
    // expiresAt safety net covers pathological cases where the event never
    // fires.
    if (ok) { onSuccess?.(); this.drainPendingCursor(entry) }
    else if (retries > 0) {
      entry.pendingEditorWrite = null
      setTimeout(() => this.applyDocToEditor(entry, retries - 1, onSuccess), 50)
    } else {
      entry.pendingEditorWrite = null
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
      this.awareness.applyRemoteCursor(entry.filePath, cursor)
    }
  }

  handleLocalEdit(e: vscode.TextDocumentChangeEvent): void {
    for (const [, entry] of this.registry.docEntries()) {
      if (entry.editor.document !== e.document) continue

      // Filter out the programmatic applyEdit we are about to see echoed
      // back. Anything else in the same event is real user input (VS Code
      // can coalesce our programmatic write with a concurrent keystroke
      // into a single onDidChangeTextDocument). See PendingEditorWrite.
      let filteredChanges: readonly vscode.TextDocumentContentChangeEvent[] = e.contentChanges
      const pew = entry.pendingEditorWrite
      if (pew) {
        if (Date.now() > pew.expiresAt) {
          entry.pendingEditorWrite = null
        } else {
          const idx = e.contentChanges.findIndex((c) =>
            c.rangeOffset === pew.change.rangeOffset &&
            c.rangeLength === pew.change.rangeLength &&
            c.text === pew.change.text
          )
          if (idx >= 0) {
            const copy = [...e.contentChanges]
            copy.splice(idx, 1)
            filteredChanges = copy
            entry.pendingEditorWrite = null
          }
        }
      }
      if (filteredChanges.length === 0) return

      // Narrow sync fence: set only during handleExternalTextEdit's
      // readFile+applyOps window. Keystrokes in that window are not
      // redelivered by VS Code, so we must drop them from Y.Doc to avoid
      // poisoning the applyOps base text. Visible buffer will be rewritten
      // by the subsequent applyDocToEditor; user sees the keystroke flicker
      // but no CRDT corruption.
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
      const lfChanges: LfChange[] = [...filteredChanges]
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
   *
   * D3 fix: `applyingRemote++` is raised BEFORE `fs.readFileSync` and
   * released AFTER `applyOps`, so a keystroke that would otherwise land in
   * Y.Doc between the disk read and the diff cannot poison `applyOps`'
   * base text. The fence is NOT held across the async `applyDocToEditor`
   * that follows — that function fences itself via `pendingEditorWrite`.
   */
  handleExternalTextEdit(filePath: string, docId: string): void {
    if (this.getRole() === "viewer") return
    const entry = this.registry.getDoc(docId)
    const bgEntry = !entry ? this.registry.getBackground(docId) : undefined
    if (!entry && !bgEntry) return

    if (entry) entry.applyingRemote++
    let rawDiskText: string
    try {
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

      if (entry) {
        applyOps(entry.yDoc)
      } else if (bgEntry) {
        // Always merge external disk edits into background docs — the
        // prefix/suffix diff is computed against current Y.Text at apply
        // time, so the merge is CRDT-correct regardless of whether the
        // server's initial STATE has arrived. The disk-write-back path
        // (scheduleBackgroundWrite) separately gates on hasReceivedState to
        // avoid echoing pre-sync content back to disk.
        applyOps(bgEntry.yDoc)
      }
    } finally {
      if (entry) entry.applyingRemote--
    }

    // Fire-and-forget: applyDocToEditor owns its own fence via
    // pendingEditorWrite, so we release applyingRemote before awaiting here.
    if (entry) {
      this.applyDocToEditor(entry)
        .catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
    }
  }

  dispose(): void {
    if (this.viewerResyncTimer) { clearTimeout(this.viewerResyncTimer); this.viewerResyncTimer = null }
  }
}
