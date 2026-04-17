import * as vscode from "vscode"
import * as path from "path"

export interface BinaryConflictInfo {
  fileId: string
  localPath: string
}

/**
 * Sidebar view listing active binary sync conflicts. The conflict picker
 * registers conflicts here on divergence; clicking a row (re-)opens the
 * QuickPick for that file.
 *
 * Text files don't appear here — Yjs CRDT merges them automatically.
 */
export class BinaryConflictsView implements vscode.TreeDataProvider<BinaryConflictInfo> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BinaryConflictInfo | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  private conflicts: BinaryConflictInfo[] = []

  setConflicts(conflicts: BinaryConflictInfo[]): void {
    this.conflicts = conflicts
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: BinaryConflictInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(element.localPath), vscode.TreeItemCollapsibleState.None)
    item.resourceUri = vscode.Uri.file(element.localPath)
    item.description = vscode.workspace.asRelativePath(element.localPath)
    item.tooltip = `Binary conflict on ${element.localPath}`
    item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
    item.command = {
      command: "shynkro.resolveBinaryConflict",
      title: "Resolve Conflict",
      arguments: [element.fileId],
    }
    return item
  }

  getChildren(): BinaryConflictInfo[] {
    return this.conflicts
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}
