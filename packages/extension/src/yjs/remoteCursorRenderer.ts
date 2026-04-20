import * as vscode from "vscode"
import type { CursorPayload } from "@shynkro/shared"

const CURSOR_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
  "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
]

interface RemoteCursorState {
  color: string
  cursorDecoration: vscode.TextEditorDecorationType
  labelAboveDecoration: vscode.TextEditorDecorationType
  labelBelowDecoration: vscode.TextEditorDecorationType
  selectionDecoration: vscode.TextEditorDecorationType
  expiryTimer: ReturnType<typeof setTimeout> | null
  /** Every editor currently showing the last-rendered cursor for this user. */
  activeEditors: Set<vscode.TextEditor>
  /** File path of the last-rendered payload — used when visible-editors change. */
  activePath: string | null
}

function findEditorsForFile(filePath: string): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter(
    (e) => e.document.uri.scheme === "file" && e.document.uri.fsPath === filePath,
  )
}

/**
 * Renders remote collaborators' cursors and selections as editor decorations.
 * Owns all decoration lifecycle — creation, per-editor updates across every
 * visible split of a doc, expiry after 5 s of inactivity, and dispose. Does
 * not touch the wire protocol; the Yjs bridge feeds it parsed CursorPayloads.
 */
export class RemoteCursorRenderer {
  private readonly remoteCursors = new Map<string, RemoteCursorState>()
  private readonly hiddenLabels = new Set<string>()
  /** Last payload per user, so visible-editor changes can re-apply it. */
  private readonly lastPayloads = new Map<string, CursorPayload>()
  private readonly visibilitySub: vscode.Disposable

  constructor() {
    this.visibilitySub = vscode.window.onDidChangeVisibleTextEditors((editors) => {
      const visible = new Set(editors)
      // Prune stale editor references, then re-render for any user whose
      // file is now visible in newly-opened panes.
      for (const [userId, state] of this.remoteCursors) {
        for (const ed of [...state.activeEditors]) {
          if (!visible.has(ed)) state.activeEditors.delete(ed)
        }
        const payload = this.lastPayloads.get(userId)
        if (payload && payload.cursor && state.activePath) {
          const panes = findEditorsForFile(state.activePath)
          if (panes.length === 0) continue
          this.renderPayload(state, payload, panes)
        }
      }
    })
  }

  private getOrCreateCursorState(userId: string, username: string): RemoteCursorState {
    const existing = this.remoteCursors.get(userId)
    if (existing) return existing
    const color = CURSOR_COLORS[this.remoteCursors.size % CURSOR_COLORS.length]
    const cursorDecoration = vscode.window.createTextEditorDecorationType({
      borderStyle: "solid", borderColor: color, borderWidth: "0 0 0 2px",
    })
    const labelAboveDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: ` ${username} `, backgroundColor: color, color: "#ffffff",
        fontWeight: "bold", fontStyle: "normal",
        textDecoration: "none; position: absolute; top: -1.35em; z-index: 1; white-space: nowrap; border-radius: 3px; padding: 0 2px;",
      },
    })
    const labelBelowDecoration = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: ` ${username} `, backgroundColor: color, color: "#ffffff",
        fontWeight: "bold", fontStyle: "normal",
        textDecoration: "none; position: absolute; top: 1.35em; z-index: 1; white-space: nowrap; border-radius: 3px; padding: 0 2px;",
      },
    })
    const selectionDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: color + "33",
    })
    const state: RemoteCursorState = {
      color, cursorDecoration, labelAboveDecoration, labelBelowDecoration, selectionDecoration,
      expiryTimer: null, activeEditors: new Set(), activePath: null,
    }
    this.remoteCursors.set(userId, state)
    return state
  }

  /**
   * Render (or clear) a remote collaborator's cursor across every visible
   * editor for `filePath`. Split views get identical decorations; panes
   * opened later are caught by `onDidChangeVisibleTextEditors`.
   */
  apply(payload: CursorPayload, filePath: string): void {
    const state = this.getOrCreateCursorState(payload.userId, payload.username)
    this.lastPayloads.set(payload.userId, payload)

    if (state.expiryTimer) clearTimeout(state.expiryTimer)
    if (payload.cursor !== null) {
      state.expiryTimer = setTimeout(() => {
        state.expiryTimer = null
        this.clearDecorationsOn(state)
      }, 5000)
    }

    if (state.activePath && state.activePath !== filePath) {
      this.clearDecorationsOn(state)
    }

    if (payload.cursor === null) {
      this.clearDecorationsOn(state)
      return
    }

    const panes = findEditorsForFile(filePath)
    if (panes.length === 0) {
      // File not currently visible — remember the payload so we render when
      // the user opens it later.
      state.activePath = filePath
      return
    }
    state.activePath = filePath
    this.renderPayload(state, payload, panes)
  }

  private renderPayload(
    state: RemoteCursorState,
    payload: CursorPayload,
    panes: vscode.TextEditor[],
  ): void {
    if (!payload.cursor) return
    const cursorPos = new vscode.Position(payload.cursor.line, payload.cursor.character)
    const cursorRange = [new vscode.Range(cursorPos, cursorPos)]

    const selRanges = payload.selection
      ? [new vscode.Range(
          new vscode.Position(payload.selection.anchor.line, payload.selection.anchor.character),
          new vscode.Position(payload.selection.active.line,  payload.selection.active.character),
        )]
      : []

    const labelHidden = this.hiddenLabels.has(payload.userId)
    const labelAboveRanges = !labelHidden && payload.cursor.line > 0 ? cursorRange : []
    const labelBelowRanges = !labelHidden && payload.cursor.line === 0 ? cursorRange : []

    for (const ed of panes) {
      state.activeEditors.add(ed)
      ed.setDecorations(state.cursorDecoration, cursorRange)
      ed.setDecorations(state.labelAboveDecoration, labelAboveRanges)
      ed.setDecorations(state.labelBelowDecoration, labelBelowRanges)
      ed.setDecorations(state.selectionDecoration, selRanges)
    }
  }

  setLabelHidden(userId: string, hidden: boolean): void {
    if (hidden) this.hiddenLabels.add(userId)
    else this.hiddenLabels.delete(userId)
    const state = this.remoteCursors.get(userId)
    if (!state) return
    for (const ed of state.activeEditors) {
      ed.setDecorations(state.labelAboveDecoration, [])
      ed.setDecorations(state.labelBelowDecoration, [])
    }
    if (!hidden) {
      const payload = this.lastPayloads.get(userId)
      if (payload && state.activePath) {
        this.renderPayload(state, payload, [...state.activeEditors])
      }
    }
  }

  private clearDecorationsOn(state: RemoteCursorState): void {
    for (const ed of state.activeEditors) {
      ed.setDecorations(state.cursorDecoration, [])
      ed.setDecorations(state.labelAboveDecoration, [])
      ed.setDecorations(state.labelBelowDecoration, [])
      ed.setDecorations(state.selectionDecoration, [])
    }
    state.activeEditors.clear()
  }

  dispose(): void {
    this.visibilitySub.dispose()
    for (const state of this.remoteCursors.values()) {
      if (state.expiryTimer) clearTimeout(state.expiryTimer)
      state.cursorDecoration.dispose()
      state.labelAboveDecoration.dispose()
      state.labelBelowDecoration.dispose()
      state.selectionDecoration.dispose()
    }
    this.remoteCursors.clear()
    this.lastPayloads.clear()
  }
}
