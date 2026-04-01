import * as vscode from "vscode"
import type { ConflictHunkMeta } from "./diffUtils"

/**
 * Manages TextEditorDecorationType instances for inline diff highlighting.
 * Green background for local (mine) lines, red for server (theirs), thin border for separator.
 */
export class ConflictDecorations implements vscode.Disposable {
  private readonly localDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(35, 134, 54, 0.3)",
    isWholeLine: true,
    overviewRulerColor: "rgba(35, 134, 54, 0.6)",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })

  private readonly serverDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(218, 54, 51, 0.3)",
    isWholeLine: true,
    overviewRulerColor: "rgba(218, 54, 51, 0.6)",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })

  applyToEditor(editor: vscode.TextEditor, hunks: ConflictHunkMeta[]): void {
    const localRanges: vscode.Range[] = []
    const serverRanges: vscode.Range[] = []

    for (const hunk of hunks) {
      if (hunk.localRange.end > hunk.localRange.start) {
        localRanges.push(new vscode.Range(hunk.localRange.start, 0, hunk.localRange.end - 1, Number.MAX_SAFE_INTEGER))
      }
      if (hunk.serverRange.end > hunk.serverRange.start) {
        serverRanges.push(new vscode.Range(hunk.serverRange.start, 0, hunk.serverRange.end - 1, Number.MAX_SAFE_INTEGER))
      }
    }

    editor.setDecorations(this.localDeco, localRanges)
    editor.setDecorations(this.serverDeco, serverRanges)
  }

  clearFromEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.localDeco, [])
    editor.setDecorations(this.serverDeco, [])
  }

  dispose(): void {
    this.localDeco.dispose()
    this.serverDeco.dispose()
  }
}
