import * as vscode from "vscode"
import * as path from "path"
import type { StateDb } from "../state/stateDb"

/**
 * Adds small badges to files in the VS Code explorer:
 *
 * - "S" badge (cloud color) = file is tracked and synced with the workspace
 * - "!" badge (warning color) = file has a pending binary conflict awaiting
 *   user action (text files no longer conflict — Yjs CRDT auto-merges)
 * - No badge = file is not tracked
 *
 * Coexists with Git's own FileDecorationProvider.
 */
export class SyncDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChange.event
  private readonly conflictPaths = new Set<string>()

  constructor(
    private readonly workspaceRoot: string,
    private readonly stateDb: StateDb,
  ) {}

  /**
   * Mark/unmark a file as having a pending binary conflict. Called by the
   * binary conflict picker when its dialog opens or closes.
   */
  setConflict(absPath: string, conflicted: boolean): void {
    if (conflicted) this.conflictPaths.add(absPath)
    else this.conflictPaths.delete(absPath)
    this._onDidChange.fire([vscode.Uri.file(absPath)])
  }

  /** Number of files currently marked as conflicting (for status bar). */
  get conflictCount(): number {
    return this.conflictPaths.size
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined
    const fsPath = uri.fsPath
    if (!fsPath.startsWith(this.workspaceRoot)) return undefined

    const relPath = path.relative(this.workspaceRoot, fsPath).replace(/\\/g, "/")
    if (!relPath || relPath.startsWith("..")) return undefined
    if (relPath.startsWith(".shynkro")) return undefined

    if (this.conflictPaths.has(fsPath)) {
      return {
        badge: "!",
        tooltip: "Shynkro: binary sync conflict — resolve before continuing",
        color: new vscode.ThemeColor("list.warningForeground"),
      }
    }

    const row = this.stateDb.getFileByPath(relPath)
    if (row) {
      return {
        badge: "S",
        tooltip: "Shynkro: synced",
        color: new vscode.ThemeColor("charts.green"),
      }
    }
    return undefined
  }

  refresh(uris?: vscode.Uri[]): void {
    this._onDidChange.fire(uris ?? undefined)
  }

  dispose(): void {
    this._onDidChange.dispose()
  }
}
