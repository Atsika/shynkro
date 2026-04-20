import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import * as Y from "yjs"
import { WS_BINARY_YJS_UPDATE, WS_BINARY_YJS_STATE, WS_BINARY_AWARENESS } from "@shynkro/shared"
import type { CursorPayload, DocId, FileId, Role, WorkspaceId } from "@shynkro/shared"
import type { WsManager } from "../ws/wsManager"
import type { FileWatcher } from "../sync/fileWatcher"
import { AwarenessController } from "./awarenessController"
import { ViewerRoleUi } from "./viewerRoleUi"
import { hydrateFromLocal, maybeCompact } from "./yjsPersistence"
import { buildBinaryFrame, editorOffsetToLfOffset, countCrInRange } from "./yjsFrames"
import {
  DocRegistry,
  findEditorForFile,
  type DocEntry,
  type BackgroundEntry,
} from "./docRegistry"
import { log } from "../logger"
import { decodeTextFile, encodeTextForDisk, defaultEol, toLf, fromLf } from "../text/textNormalize"
import { atomicWriteFileSync } from "../text/atomicWrite"

/**
 * Maximum size of a single Yjs insert (in characters) before it gets split into
 * multiple smaller transactions. Each transact() emits one WS frame, so capping
 * the per-transact size keeps frames well under the server's 50 MB safety net.
 */
const PASTE_CHUNK_THRESHOLD = 256 * 1024

export class YjsBridge {
  private readonly registry = new DocRegistry()
  private readonly disposables: vscode.Disposable[] = []
  private currentRole: Role = "editor"
  private viewerResyncTimer: ReturnType<typeof setTimeout> | null = null
  private readonly awareness: AwarenessController
  private readonly viewerUi: ViewerRoleUi
  private readonly selectionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastActiveDocId: string | null = null

  constructor(
    private readonly wsManager: WsManager,
    private readonly fileWatcher: FileWatcher,
    private readonly stateDb: import("../state/stateDb").StateDb,
    private readonly workspaceRoot: string,
  ) {
    this.awareness = new AwarenessController(wsManager)
    this.viewerUi = new ViewerRoleUi(wsManager, workspaceRoot)
    this.disposables.push(
      wsManager.onBinaryFrame((frame) => this.handleBinaryFrame(frame)),
      vscode.workspace.onDidChangeTextDocument((e) => this.handleLocalEdit(e)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.handleDocClose(doc)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.currentRole === "viewer" && editor.document.uri.scheme === "file" && this.viewerUi.isWorkspacePath(editor.document.uri.fsPath)) {
          vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
          const docEntry = [...this.registry.docValues()].find(e => e.editor.document === editor.document)
          if (docEntry) this.viewerUi.showPermissionRequestPopup(docEntry.workspaceId)
        }
        const newDocId = editor ? this.registry.findDocIdForPath(editor.document.uri.fsPath) : null
        if (this.lastActiveDocId && this.lastActiveDocId !== newDocId) {
          this.awareness.sendCursorClear(this.lastActiveDocId)
        }
        this.lastActiveDocId = newDocId
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        for (const [docId, entry] of this.registry.docEntries()) {
          if (entry.editor.document.uri.fsPath !== e.textEditor.document.uri.fsPath) continue
          entry.editor = e.textEditor
          this.lastActiveDocId = docId
          if (entry.applyingRemote > 0) break
          const existing = this.selectionTimers.get(docId)
          if (existing) clearTimeout(existing)
          this.selectionTimers.set(docId, setTimeout(() => {
            this.selectionTimers.delete(docId)
            this.awareness.sendCursorUpdate(docId, e.textEditor.selection)
          }, 50))
          break
        }
      }),
    )
  }

  private hydrateFromLocal(docId: string): Y.Doc {
    return hydrateFromLocal(this.stateDb, docId)
  }

  private maybeCompact(docId: string, yDoc: Y.Doc): void {
    maybeCompact(this.stateDb, docId, yDoc)
  }

  /**
   * Subscribe to a doc tied to an open editor. If the doc was already in
   * background sync, migrate its Y.Doc. Otherwise hydrate from local
   * persistence so the doc is immediately usable even before the WS responds.
   */
  openDoc(fileId: FileId, docId: DocId, workspaceId: WorkspaceId, filePath: string, editor: vscode.TextEditor): void {
    const existing = this.registry.getDoc(docId)
    if (existing) {
      existing.editor = editor
      return
    }

    this.registry.evictStaleEntriesForPath(filePath, docId)

    let yDoc: Y.Doc
    let hasReceivedState = false
    const bgEntry = this.registry.getBackground(docId)

    if (bgEntry) {
      if (bgEntry.writeTimer) clearTimeout(bgEntry.writeTimer)
      yDoc = bgEntry.yDoc
      hasReceivedState = bgEntry.hasReceivedState
      this.registry.deleteBackground(docId)
      yDoc.off("update", this.registry.getHandler(docId))
      log.appendLine(`[yjsBridge] openDoc (migrated from background) ${path.basename(filePath)}`)
    } else {
      yDoc = this.hydrateFromLocal(docId)
      log.appendLine(`[yjsBridge] openDoc ${path.basename(filePath)} docId=${docId}`)
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId })
    }

    const entry: DocEntry = {
      yDoc, fileId, filePath, workspaceId, editor,
      applyingRemote: 0,
      hasReceivedState,
      pendingCursor: null,
    }
    this.registry.setDoc(docId, entry)

    if (this.currentRole === "viewer") {
      vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
    }

    const handler = this.createUpdateHandler(docId, yDoc)
    this.registry.setHandler(docId, handler)
    yDoc.on("update", handler)

    if (hasReceivedState || this.stateDb.loadYjsSnapshot(docId) !== undefined) {
      this.applyDocToEditor(entry).catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
    }
  }

  subscribeBackground(docId: string, workspaceId: WorkspaceId, filePath: string): void {
    if (this.registry.hasDoc(docId) || this.registry.hasBackground(docId)) return
    this.registry.evictStaleEntriesForPath(filePath, docId)
    log.appendLine(`[yjsBridge] subscribeBackground ${path.basename(filePath)}`)
    const yDoc = this.hydrateFromLocal(docId)
    const bgEntry: BackgroundEntry = {
      yDoc, filePath, workspaceId, writeTimer: null,
      hasReceivedState: false,
    }
    this.registry.setBackground(docId, bgEntry)
    const handler = this.createUpdateHandler(docId, yDoc)
    this.registry.setHandler(docId, handler)
    yDoc.on("update", handler)
    this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId: docId as DocId })
  }

  /**
   * Factory for the `yDoc.on("update")` handler. Every mount site (openDoc,
   * subscribeBackground, handleDocClose → background) shares the same policy:
   * persist local + remote updates, send locals over the wire, ack on send,
   * and nudge the compactor.
   */
  private createUpdateHandler(docId: string, yDoc: Y.Doc): (update: Uint8Array, origin: unknown) => void {
    return (update, origin) => {
      if (origin === "local-restore") return
      const isLocal = origin !== "remote"
      const acked = !isLocal
      const id = this.stateDb.appendYjsUpdate(docId, update, isLocal ? "local" : "remote", acked)
      if (isLocal) {
        const frame = buildBinaryFrame(WS_BINARY_YJS_UPDATE, docId, update)
        const sent = this.wsManager.sendBinary(frame)
        if (sent) this.stateDb.markYjsUpdateAcked(id)
      }
      this.maybeCompact(docId, yDoc)
    }
  }

  /**
   * On receipt of an initial server state frame, ack any local updates the
   * server has already absorbed, so the compactor can reclaim them. Called
   * from both foreground and background paths — identical logic.
   */
  private trimAckedLocalUpdates(docId: string, frameData: Uint8Array, yDoc: Y.Doc): void {
    try {
      const serverProbe = new Y.Doc()
      Y.applyUpdate(serverProbe, frameData, "remote")
      const serverVec = Y.encodeStateVector(serverProbe)
      serverProbe.destroy()
      const unacked = this.stateDb.loadUnackedLocalUpdates(docId)
      for (const u of unacked) {
        const remaining = Y.diffUpdate(u.bytes, serverVec)
        // diffUpdate returns a "header-only" update of length 2 when nothing remains.
        if (remaining.length <= 2) this.stateDb.markYjsUpdateAcked(u.id)
      }
      this.maybeCompact(docId, yDoc)
    } catch (err) {
      log.appendLine(`[yjsBridge] state-vector trim failed for ${docId}: ${err}`)
    }
  }

  /** Re-subscribe all open + background docs after a reconnect. */
  notifyConnected(workspaceId: WorkspaceId): void {
    for (const [docId, entry] of this.registry.docEntries()) {
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId: docId as DocId })
      entry.applyingRemote = 0
      entry.hasReceivedState = false
      // Peers cleared our cursor decoration after their 5 s inactivity timer
      // fired during the disconnect. Re-announce so they can render it again
      // without waiting for the next selection change.
      const liveEditor = findEditorForFile(entry.filePath)
      if (liveEditor) this.awareness.sendCursorUpdate(docId, liveEditor.selection)
    }
    for (const [docId, bgEntry] of this.registry.backgroundEntries()) {
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId: bgEntry.workspaceId, docId: docId as DocId })
      bgEntry.hasReceivedState = false
    }
  }

  setRole(role: Role): void {
    const wasViewer = this.currentRole === "viewer"
    const wasEditor = this.currentRole !== "viewer"
    this.currentRole = role
    if (role === "viewer") {
      this.viewerUi.lockAllTrackedEditors()
      if (wasEditor) {
        // Force a fresh server state so any phantom edits typed before the
        // demotion landed get discarded. CRDT will merge in unsynced locals
        // that the server already applied.
        for (const [docId, entry] of this.registry.docEntries()) {
          entry.hasReceivedState = false
          this.wsManager.sendJson({ type: "subscribeDoc", workspaceId: entry.workspaceId, docId: docId as DocId })
        }
        this.viewerUi.setStatusBarVisible(true)
      }
    } else {
      this.viewerUi.resetPermissionPopup()
      this.viewerUi.setStatusBarVisible(false)
      if (wasViewer) {
        this.viewerUi.unlockAllTrackedEditors()
        for (const entry of this.registry.docValues()) {
          this.applyDocToEditor(entry).catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
        }
      }
    }
  }

  setUsername(name: string): void {
    this.awareness.setUsername(name)
  }

  closeDoc(docId: DocId): void {
    const entry = this.registry.getDoc(docId)
    if (!entry) return
    this.wsManager.sendJson({ type: "unsubscribeDoc", docId })
    entry.yDoc.destroy()
    this.registry.deleteDoc(docId)
    this.registry.deleteHandler(docId)
  }

  async handleFileDeleted(absPath: string, opts: { remote: boolean; deletedBy?: string }): Promise<void> {
    let matchedDocId: string | null = null
    let matchedEntry: DocEntry | null = null
    for (const [docId, entry] of this.registry.docEntries()) {
      if (entry.filePath === absPath) { matchedDocId = docId; matchedEntry = entry; break }
    }
    if (!matchedDocId) {
      for (const [docId, bg] of this.registry.backgroundEntries()) {
        if (bg.filePath === absPath) {
          if (bg.writeTimer) clearTimeout(bg.writeTimer)
          this.wsManager.sendJson({ type: "unsubscribeDoc", docId: docId as DocId })
          const h = this.registry.getHandler(docId)
          bg.yDoc.off("update", h)
          this.registry.deleteHandler(docId)
          bg.yDoc.destroy()
          this.registry.deleteBackground(docId)
          this.stateDb.purgeYjsForDoc(docId)
          log.appendLine(`[yjsBridge] closed background doc for deleted file ${path.basename(absPath)}`)
          return
        }
      }
      return
    }
    if (!matchedEntry) return

    const doc = matchedEntry.editor.document
    const isDirty = !doc.isClosed && doc.isDirty
    if (opts.remote && isDirty) {
      const who = opts.deletedBy ? ` by ${opts.deletedBy}` : ""
      const choice = await vscode.window.showWarningMessage(
        `Shynkro: "${path.basename(absPath)}" was deleted${who}, but you have unsaved changes. Save a local copy?`,
        { modal: true }, "Save Local Copy", "Discard"
      )
      if (choice === "Save Local Copy") {
        const recoveredPath = `${absPath}.recovered-${Date.now()}`
        try {
          fs.writeFileSync(recoveredPath, doc.getText(), "utf-8")
          vscode.window.showInformationMessage(`Shynkro: saved recovery copy at ${path.basename(recoveredPath)}`)
        } catch (err) {
          log.appendLine(`[yjsBridge] failed to write recovery copy ${recoveredPath}: ${err}`)
        }
      }
    }

    this.closeDoc(matchedDocId as DocId)
    this.stateDb.purgeYjsForDoc(matchedDocId)

    try {
      const uri = doc.uri
      const tabsToClose: vscode.Tab[] = []
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined
          if (input?.uri?.toString() === uri.toString()) tabsToClose.push(tab)
        }
      }
      if (tabsToClose.length > 0) await vscode.window.tabGroups.close(tabsToClose, true)
    } catch (err) {
      log.appendLine(`[yjsBridge] failed to close tabs for deleted file ${path.basename(absPath)}: ${err}`)
    }
  }

  /**
   * External tool wrote to a tracked file (vim, git, etc.). Diff into the Yjs
   * doc as prefix/suffix-aware ops so it propagates as a normal update.
   */
  handleExternalTextEdit(filePath: string, docId: string): void {
    if (this.currentRole === "viewer") return
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

  private handleBinaryFrame(frame: { frameType: number; docId: string; data: Uint8Array }): void {
    const entry = this.registry.getDoc(frame.docId)
    if (entry) {
      if (frame.frameType === WS_BINARY_YJS_STATE || frame.frameType === WS_BINARY_YJS_UPDATE) {
        const isInitialState = frame.frameType === WS_BINARY_YJS_STATE
        // Hold the suppression flag across Y.applyUpdate and the editor
        // write-back: a keystroke that lands between Y.applyUpdate and
        // applyDocToEditor would otherwise be overwritten by the stale diff
        // ranges computed against pre-keystroke text.
        entry.applyingRemote++
        try {
          Y.applyUpdate(entry.yDoc, frame.data, "remote")
          if (isInitialState) {
            // Server state arrived: ack any local updates it already absorbed.
            this.trimAckedLocalUpdates(frame.docId, frame.data, entry.yDoc)
            entry.hasReceivedState = true
          }
        } catch (err) {
          entry.applyingRemote--
          throw err
        }
        this.applyDocToEditor(entry)
          .catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
          .finally(() => { entry.applyingRemote-- })
      } else if (frame.frameType === WS_BINARY_AWARENESS) {
        if (entry.applyingRemote > 0) {
          try {
            const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
            if (payload.userId !== this.awareness.selfUserId) entry.pendingCursor = payload
          } catch {}
          return
        }
        try {
          const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
          if (payload.userId !== this.awareness.selfUserId) {
            this.awareness.applyRemoteCursor(entry.filePath, entry.editor, payload)
            if (this.awareness.isFollowing(payload.userId)) {
              this.awareness.applyFollowNavigation(frame.docId, entry.filePath, payload)
            }
          }
        } catch {}
      }
      return
    }

    const bgEntry = this.registry.getBackground(frame.docId)
    if (bgEntry) {
      if (frame.frameType === WS_BINARY_YJS_STATE || frame.frameType === WS_BINARY_YJS_UPDATE) {
        const isInitialState = frame.frameType === WS_BINARY_YJS_STATE
        Y.applyUpdate(bgEntry.yDoc, frame.data, "remote")
        if (isInitialState) {
          bgEntry.hasReceivedState = true
          this.trimAckedLocalUpdates(frame.docId, frame.data, bgEntry.yDoc)
        }
        this.scheduleBackgroundWrite(frame.docId, bgEntry)
      } else if (frame.frameType === WS_BINARY_AWARENESS) {
        if (this.awareness.followedUserId) {
          try {
            const payload = JSON.parse(Buffer.from(frame.data).toString("utf-8")) as CursorPayload
            if (this.awareness.isFollowing(payload.userId)) {
              this.awareness.applyFollowNavigation(frame.docId, bgEntry.filePath, payload)
            }
          } catch {}
        }
      }
    }
  }

  private scheduleBackgroundWrite(docId: string, entry: BackgroundEntry): void {
    if (entry.writeTimer) clearTimeout(entry.writeTimer)
    entry.writeTimer = setTimeout(() => {
      entry.writeTimer = null
      const relPath = path.relative(this.workspaceRoot, entry.filePath).replace(/\\/g, "/")
      const row = this.stateDb.getFileByPath(relPath)
      if (!row) {
        log.appendLine(`[yjsBridge] skipping background write for deleted file ${path.basename(entry.filePath)}`)
        this.registry.deleteBackground(docId)
        return
      }
      const lfText = entry.yDoc.getText("content").toString()
      const eol = (row.eolStyle ?? defaultEol()) as "lf" | "crlf"
      const bom = !!row.hasBom
      const encoded = encodeTextForDisk(lfText, eol, bom)
      try {
        this.fileWatcher.addWriteTag(entry.filePath)
        atomicWriteFileSync(entry.filePath, encoded, { encoding: "utf-8" })
      } catch (err) {
        log.appendLine(`[yjsBridge] background write error for ${path.basename(entry.filePath)}: ${err}`)
      }
    }, 300)
  }

  /**
   * Push the Y.Doc text into its editor using a minimal prefix/suffix replace,
   * so decorations (cursors, selections) outside the changed region survive.
   */
  private async applyDocToEditor(entry: DocEntry, retries = 3, onSuccess?: () => void): Promise<void> {
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

  private handleDocClose(doc: vscode.TextDocument): void {
    for (const [docId, entry] of this.registry.docEntries()) {
      if (entry.editor.document !== doc) continue
      this.awareness.sendCursorClear(docId)
      const handler = this.registry.getHandler(docId)
      entry.yDoc.off("update", handler)
      this.registry.deleteHandler(docId)
      this.registry.deleteDoc(docId)
      const bgEntry: BackgroundEntry = {
        yDoc: entry.yDoc,
        filePath: entry.filePath,
        workspaceId: entry.workspaceId,
        writeTimer: null,
        hasReceivedState: entry.hasReceivedState,
      }
      this.registry.setBackground(docId, bgEntry)
      const bgHandler = this.createUpdateHandler(docId, entry.yDoc)
      this.registry.setHandler(docId, bgHandler)
      entry.yDoc.on("update", bgHandler)
      log.appendLine(`[yjsBridge] editor closed, demoted to background: ${path.basename(entry.filePath)}`)
      return
    }
  }

  private handleLocalEdit(e: vscode.TextDocumentChangeEvent): void {
    for (const [, entry] of this.registry.docEntries()) {
      if (entry.editor.document !== e.document) continue
      if (entry.applyingRemote > 0) return
      if (this.currentRole === "viewer") {
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


  startFollowing(userId: string): void { this.awareness.startFollowing(userId) }
  stopFollowing(): void { this.awareness.stopFollowing() }
  get followedUserId(): string | null { return this.awareness.followedUserId }
  setLabelHidden(userId: string, hidden: boolean): void { this.awareness.setLabelHidden(userId, hidden) }

  dispose(): void {
    if (this.viewerResyncTimer) { clearTimeout(this.viewerResyncTimer); this.viewerResyncTimer = null }
    for (const [docId, entry] of this.registry.docEntries()) {
      this.wsManager.sendJson({ type: "unsubscribeDoc", docId: docId as DocId })
      const h = this.registry.getHandler(docId)
      entry.yDoc.off("update", h)
      entry.yDoc.destroy()
    }
    for (const [docId, bgEntry] of this.registry.backgroundEntries()) {
      this.wsManager.sendJson({ type: "unsubscribeDoc", docId: docId as DocId })
      if (bgEntry.writeTimer) clearTimeout(bgEntry.writeTimer)
      const h = this.registry.getHandler(docId)
      bgEntry.yDoc.off("update", h)
      bgEntry.yDoc.destroy()
    }
    for (const timer of this.selectionTimers.values()) clearTimeout(timer)
    this.selectionTimers.clear()
    this.awareness.dispose()
    this.registry.clear()
    this.viewerUi.dispose()
    this.disposables.forEach((d) => d.dispose())
  }
}
