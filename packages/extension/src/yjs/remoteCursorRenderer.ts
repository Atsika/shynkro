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
  activeEditor: vscode.TextEditor | null
}

/**
 * Renders remote collaborators' cursors and selections as editor decorations.
 * Owns all decoration lifecycle — creation, per-editor updates, expiry after
 * 5s of inactivity, and dispose. Does not touch the wire protocol; the Yjs
 * bridge feeds it parsed CursorPayloads.
 */
export class RemoteCursorRenderer {
  private readonly remoteCursors = new Map<string, RemoteCursorState>()
  private readonly hiddenLabels = new Set<string>()

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
      expiryTimer: null, activeEditor: null,
    }
    this.remoteCursors.set(userId, state)
    return state
  }

  /**
   * Render (or clear) a remote collaborator's cursor in the given editor.
   * `liveEditor` is the currently-open editor for the doc the cursor belongs
   * to — the renderer migrates decorations across if the user focuses a
   * different copy of the same file.
   */
  apply(payload: CursorPayload, liveEditor: vscode.TextEditor): void {
    const state = this.getOrCreateCursorState(payload.userId, payload.username)

    if (state.expiryTimer) clearTimeout(state.expiryTimer)
    if (payload.cursor !== null) {
      state.expiryTimer = setTimeout(() => {
        state.expiryTimer = null
        this.clearDecorationsOn(state)
      }, 5000)
    }

    if (state.activeEditor && state.activeEditor.document.uri.fsPath !== liveEditor.document.uri.fsPath) {
      this.clearDecorationsOn(state)
    }

    if (payload.cursor === null) {
      this.clearDecorationsOn(state)
      return
    }

    state.activeEditor = liveEditor
    const cursorPos = new vscode.Position(payload.cursor.line, payload.cursor.character)
    liveEditor.setDecorations(state.cursorDecoration, [new vscode.Range(cursorPos, cursorPos)])

    if (this.hiddenLabels.has(payload.userId)) {
      liveEditor.setDecorations(state.labelAboveDecoration, [])
      liveEditor.setDecorations(state.labelBelowDecoration, [])
    } else if (payload.cursor.line === 0) {
      liveEditor.setDecorations(state.labelAboveDecoration, [])
      liveEditor.setDecorations(state.labelBelowDecoration, [new vscode.Range(cursorPos, cursorPos)])
    } else {
      liveEditor.setDecorations(state.labelBelowDecoration, [])
      liveEditor.setDecorations(state.labelAboveDecoration, [new vscode.Range(cursorPos, cursorPos)])
    }

    if (payload.selection) {
      const selRange = new vscode.Range(
        new vscode.Position(payload.selection.anchor.line, payload.selection.anchor.character),
        new vscode.Position(payload.selection.active.line,  payload.selection.active.character),
      )
      liveEditor.setDecorations(state.selectionDecoration, [selRange])
    } else {
      liveEditor.setDecorations(state.selectionDecoration, [])
    }
  }

  setLabelHidden(userId: string, hidden: boolean): void {
    if (hidden) this.hiddenLabels.add(userId)
    else this.hiddenLabels.delete(userId)
    const state = this.remoteCursors.get(userId)
    if (state?.activeEditor) {
      state.activeEditor.setDecorations(state.labelAboveDecoration, [])
      state.activeEditor.setDecorations(state.labelBelowDecoration, [])
    }
  }

  private clearDecorationsOn(state: RemoteCursorState): void {
    if (!state.activeEditor) return
    state.activeEditor.setDecorations(state.cursorDecoration, [])
    state.activeEditor.setDecorations(state.labelAboveDecoration, [])
    state.activeEditor.setDecorations(state.labelBelowDecoration, [])
    state.activeEditor.setDecorations(state.selectionDecoration, [])
    state.activeEditor = null
  }

  dispose(): void {
    for (const state of this.remoteCursors.values()) {
      if (state.expiryTimer) clearTimeout(state.expiryTimer)
      state.cursorDecoration.dispose()
      state.labelAboveDecoration.dispose()
      state.labelBelowDecoration.dispose()
      state.selectionDecoration.dispose()
    }
    this.remoteCursors.clear()
  }
}
