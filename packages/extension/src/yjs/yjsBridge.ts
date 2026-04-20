import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import * as Y from "yjs"
import type { DocId, FileId, Role, WorkspaceId } from "@shynkro/shared"
import type { WsManager } from "../ws/wsManager"
import type { FileWatcher } from "../sync/fileWatcher"
import { AwarenessController } from "./awarenessController"
import { ViewerRoleUi } from "./viewerRoleUi"
import { hydrateFromLocal } from "./yjsPersistence"
import {
  DocRegistry,
  findEditorForFile,
  type DocEntry,
  type BackgroundEntry,
} from "./docRegistry"
import { TextSyncEngine } from "./textSyncEngine"
import { YjsFrameRouter } from "./yjsFrameRouter"
import { log } from "../logger"

export class YjsBridge {
  private readonly registry = new DocRegistry()
  private readonly disposables: vscode.Disposable[] = []
  private currentRole: Role = "editor"
  private readonly awareness: AwarenessController
  private readonly viewerUi: ViewerRoleUi
  private readonly textSync: TextSyncEngine
  private readonly router: YjsFrameRouter
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
    this.textSync = new TextSyncEngine(
      this.registry, this.awareness, this.viewerUi, stateDb, workspaceRoot,
      () => this.currentRole,
    )
    this.router = new YjsFrameRouter(
      this.registry, this.awareness, this.textSync,
      wsManager, fileWatcher, stateDb, workspaceRoot,
    )
    this.disposables.push(
      wsManager.onBinaryFrame((frame) => this.router.handleBinaryFrame(frame)),
      wsManager.onServerMessage((msg) => {
        if (msg.type === "yjsUpdateAck") {
          this.router.handleAck(msg.docId, msg.clientUpdateId)
        }
      }),
      wsManager.onStatusChange((s) => {
        // Disconnect: abort any in-flight background-write timer so we don't
        // echo pre-reconnect Y.Doc content onto disk mid-refresh. The next
        // STATE frame after reconnect drains the write via flushBackgroundWrite.
        if (s === "disconnected") this.router.cancelPendingBackgroundWrites()
      }),
      vscode.workspace.onDidChangeTextDocument((e) => this.textSync.handleLocalEdit(e)),
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
    let hasLocalState = false
    const bgEntry = this.registry.getBackground(docId)

    if (bgEntry) {
      if (bgEntry.writeTimer) clearTimeout(bgEntry.writeTimer)
      yDoc = bgEntry.yDoc
      hasReceivedState = bgEntry.hasReceivedState
      hasLocalState = hasReceivedState
      this.registry.deleteBackground(docId)
      yDoc.off("update", this.registry.getHandler(docId))
      log.appendLine(`[yjsBridge] openDoc (migrated from background) ${path.basename(filePath)}`)
    } else {
      const hydrated = hydrateFromLocal(this.stateDb, docId)
      yDoc = hydrated.yDoc
      hasLocalState = hydrated.hasLocalState
      // Any local state (snapshot OR updates) counts as "we have meaningful
      // CRDT content" — the editor buffer should reflect it even before the
      // server replies. hasReceivedState conflates "server confirmed" with
      // "safe to project Y.Doc onto editor"; seed it from local too.
      hasReceivedState = hasLocalState
      log.appendLine(`[yjsBridge] openDoc ${path.basename(filePath)} docId=${docId}`)
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId })
    }

    const entry: DocEntry = {
      yDoc, fileId, filePath, workspaceId, editor,
      applyingRemote: 0,
      hasReceivedState,
      pendingCursor: null,
      recoveryMode: false,
    }
    this.registry.setDoc(docId, entry)

    if (this.currentRole === "viewer") {
      vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
    }

    const handler = this.router.createUpdateHandler(docId, yDoc)
    this.registry.setHandler(docId, handler)
    yDoc.on("update", handler)

    // Apply whenever we have meaningful local CRDT content — not only when a
    // snapshot exists. Update-only state is still correct state. Skip when
    // the editor has unsaved user changes so we don't clobber an in-progress
    // buffer (applyDocToEditor already fast-exits on text-equality, so the
    // snapshot-only path is effectively a free no-op when text matches).
    if (hasLocalState && !editor.document.isDirty) {
      this.textSync.applyDocToEditor(entry).catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
    }
  }

  subscribeBackground(docId: string, workspaceId: WorkspaceId, filePath: string): void {
    if (this.registry.hasDoc(docId) || this.registry.hasBackground(docId)) return
    this.registry.evictStaleEntriesForPath(filePath, docId)
    log.appendLine(`[yjsBridge] subscribeBackground ${path.basename(filePath)}`)
    const { yDoc, hasLocalState } = hydrateFromLocal(this.stateDb, docId)
    const bgEntry: BackgroundEntry = {
      yDoc, filePath, workspaceId, writeTimer: null,
      // Seed from local hydration so the first external disk edit is merged
      // instead of being dropped behind the hasReceivedState gate.
      hasReceivedState: hasLocalState,
    }
    this.registry.setBackground(docId, bgEntry)
    const handler = this.router.createUpdateHandler(docId, yDoc)
    this.registry.setHandler(docId, handler)
    yDoc.on("update", handler)
    this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId: docId as DocId })
  }

  /** Re-subscribe all open + background docs after a reconnect. */
  notifyConnected(workspaceId: WorkspaceId): void {
    for (const [docId, entry] of this.registry.docEntries()) {
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId, docId: docId as DocId })
      entry.applyingRemote = 0
      // Do NOT reset hasReceivedState. The frame-type discriminates fresh
      // STATE from incremental UPDATE on receipt; resetting caused external
      // edits between reconnect and the next STATE frame to be dropped
      // (D6/D8) and had no other purpose.
      //
      // Peers cleared our cursor decoration after their 5 s inactivity timer
      // fired during the disconnect. Re-announce so they can render it again
      // without waiting for the next selection change.
      const liveEditor = findEditorForFile(entry.filePath)
      if (liveEditor) this.awareness.sendCursorUpdate(docId, liveEditor.selection)
    }
    for (const [docId, bgEntry] of this.registry.backgroundEntries()) {
      this.wsManager.sendJson({ type: "subscribeDoc", workspaceId: bgEntry.workspaceId, docId: docId as DocId })
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
          this.textSync.applyDocToEditor(entry).catch((err) => log.appendLine(`[yjsBridge] applyDocToEditor rejected: ${err}`))
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
        const content = doc.getText()
        let written = false
        try {
          fs.writeFileSync(recoveredPath, content, "utf-8")
          written = true
        } catch (err) {
          log.appendLine(`[yjsBridge] sync recovery write failed ${recoveredPath}: ${err}`)
          try {
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(recoveredPath),
              Buffer.from(content, "utf-8"),
            )
            written = true
          } catch (err2) {
            log.appendLine(`[yjsBridge] fallback recovery write failed ${recoveredPath}: ${err2}`)
            const keepChoice = await vscode.window.showErrorMessage(
              `Shynkro: could not write recovery copy for "${path.basename(absPath)}" (${err2}). Keep the buffer in memory so you can retry?`,
              { modal: true }, "Keep", "Discard",
            )
            if (keepChoice === "Keep") {
              matchedEntry.recoveryMode = true
              log.appendLine(`[yjsBridge] entered recoveryMode for ${matchedDocId}: outbound/inbound suppressed until shynkro.exitRecovery`)
              vscode.window.showInformationMessage(
                `Shynkro: buffer preserved. Save-As elsewhere, then run "Shynkro: Exit Recovery Mode" to resume sync.`,
              )
              return
            }
          }
        }
        if (written) {
          vscode.window.showInformationMessage(`Shynkro: saved recovery copy at ${path.basename(recoveredPath)}`)
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

  handleExternalTextEdit(filePath: string, docId: string): void {
    this.textSync.handleExternalTextEdit(filePath, docId)
  }

  /**
   * Surface every doc currently held in recovery mode so the extension can
   * offer a user-facing pick list when invoking `shynkro.exitRecovery`.
   */
  listRecoveryDocs(): Array<{ docId: string; filePath: string }> {
    const out: Array<{ docId: string; filePath: string }> = []
    for (const [docId, entry] of this.registry.docEntries()) {
      if (entry.recoveryMode) out.push({ docId, filePath: entry.filePath })
    }
    return out
  }

  /**
   * Resume normal sync on a doc that has been held in recovery mode. The
   * caller is expected to have preserved the user's content out-of-band
   * (Save-As, copy-paste, etc.); we tear down the local CRDT state so the
   * next open starts from the authoritative server state.
   */
  exitRecoveryMode(docId: string): void {
    const entry = this.registry.getDoc(docId as DocId)
    if (!entry || !entry.recoveryMode) return
    entry.recoveryMode = false
    log.appendLine(`[yjsBridge] exitRecoveryMode ${docId}: tearing down local state`)
    this.closeDoc(docId as DocId)
    this.stateDb.purgeYjsForDoc(docId)
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
      const bgHandler = this.router.createUpdateHandler(docId, entry.yDoc)
      this.registry.setHandler(docId, bgHandler)
      entry.yDoc.on("update", bgHandler)
      log.appendLine(`[yjsBridge] editor closed, demoted to background: ${path.basename(entry.filePath)}`)
      return
    }
  }

  startFollowing(userId: string): void { this.awareness.startFollowing(userId) }
  stopFollowing(): void { this.awareness.stopFollowing() }
  get followedUserId(): string | null { return this.awareness.followedUserId }
  setLabelHidden(userId: string, hidden: boolean): void { this.awareness.setLabelHidden(userId, hidden) }

  dispose(): void {
    this.textSync.dispose()
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
