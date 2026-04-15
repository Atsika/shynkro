import * as vscode from "vscode"
import * as path from "path"
import type { StateDb } from "../state/stateDb"
import type { ConflictManager } from "../conflict/conflictManager"

/**
 * Adds small badges to files in the VS Code explorer so the user can see
 * at a glance which files are being synced by Shynkro and which aren't.
 *
 * - "S" badge (cloud color) = file is tracked and synced with the workspace
 * - "!" badge (warning color) = file has an active sync conflict
 * - No badge = file is not tracked (ignored, outside workspace, case collision orphan, etc.)
 *
 * Coexists with Git's own FileDecorationProvider — VS Code renders multiple
 * badges side by side.
 */
export class SyncDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>()
  readonly onDidChangeFileDecorations = this._onDidChange.event

  constructor(
    private readonly workspaceRoot: string,
    private readonly stateDb: StateDb,
    private readonly conflictManager: ConflictManager
  ) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") return undefined

    // Only decorate files inside the workspace root
    const fsPath = uri.fsPath
    if (!fsPath.startsWith(this.workspaceRoot)) return undefined

    const relPath = path.relative(this.workspaceRoot, fsPath).replace(/\\/g, "/")
    if (!relPath || relPath.startsWith("..")) return undefined

    // Skip the .shynkro directory itself
    if (relPath.startsWith(".shynkro")) return undefined

    // Check for active conflict first (takes priority over "synced")
    const allConflicts = this.conflictManager.getConflicts()
    const hasConflict = allConflicts.some((c: { filePath: string }) => {
      const conflictRel = path.relative(this.workspaceRoot, c.filePath).replace(/\\/g, "/")
      return conflictRel === relPath
    })
    if (hasConflict) {
      return {
        badge: "!",
        tooltip: "Shynkro: sync conflict — resolve before continuing",
        color: new vscode.ThemeColor("list.warningForeground"),
      }
    }

    // Check if the file is tracked
    const row = this.stateDb.getFileByPath(relPath)
    if (row) {
      return {
        badge: "S",
        tooltip: "Shynkro: synced",
        color: new vscode.ThemeColor("charts.green"),
      }
    }

    // Not tracked — no decoration. The absence of "S" is the indicator.
    return undefined
  }

  /** Call when files are added/removed/renamed to refresh decorations. */
  refresh(uris?: vscode.Uri[]): void {
    this._onDidChange.fire(uris ?? undefined)
  }

  dispose(): void {
    this._onDidChange.dispose()
  }
}
