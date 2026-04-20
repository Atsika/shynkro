import * as vscode from "vscode"
import type { CursorPayload, DocId } from "@shynkro/shared"
import type { WsManager } from "../ws/wsManager"
import { RemoteCursorRenderer } from "./remoteCursorRenderer"
import { findEditorForFile } from "./docRegistry"

/**
 * Owns peer-cursor send/receive and follow-mode navigation. Wraps the
 * RemoteCursorRenderer so the bridge only needs to forward incoming
 * awareness payloads and selection events.
 */
export class AwarenessController {
  private readonly cursorRenderer = new RemoteCursorRenderer()
  private followingUserId: string | null = null
  private lastFollowedDocId: string | null = null
  private username = ""

  constructor(private readonly wsManager: WsManager) {}

  setUsername(name: string): void {
    this.username = name
  }

  get selfUserId(): string {
    return this.wsManager.userId
  }

  sendCursorUpdate(docId: string, selection: vscode.Selection): void {
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

  sendCursorClear(docId: string): void {
    if (!this.wsManager.connected) return
    const payload: CursorPayload = {
      userId: this.wsManager.userId, username: this.username, cursor: null, selection: null,
    }
    const data = Buffer.from(JSON.stringify(payload)).toString("base64")
    this.wsManager.sendJson({ type: "awarenessUpdate", docId: docId as DocId, data })
  }

  applyRemoteCursor(filePath: string, fallbackEditor: vscode.TextEditor, payload: CursorPayload): void {
    const liveEditor = findEditorForFile(filePath) ?? fallbackEditor
    this.cursorRenderer.apply(payload, liveEditor)
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

  isFollowing(userId: string | undefined): boolean {
    return this.followingUserId !== null && this.followingUserId === userId
  }

  applyFollowNavigation(docId: string, filePath: string, payload: CursorPayload): void {
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
      const editor = findEditorForFile(filePath)
      if (editor) editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }
  }

  setLabelHidden(userId: string, hidden: boolean): void {
    this.cursorRenderer.setLabelHidden(userId, hidden)
  }

  dispose(): void {
    this.cursorRenderer.dispose()
  }
}
