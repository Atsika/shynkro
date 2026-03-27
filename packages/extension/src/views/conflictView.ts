import * as path from "path"
import * as vscode from "vscode"
import type { ConflictManager } from "../conflict/conflictManager"

export class ConflictItem extends vscode.TreeItem {
  readonly docId: string
  readonly filePath: string

  constructor(docId: string, filePath: string) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None)
    this.docId = docId
    this.filePath = filePath
    this.tooltip = filePath
    this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"))
    this.command = {
      command: "vscode.open",
      title: "Open file",
      arguments: [vscode.Uri.file(filePath)],
    }
  }
}

export class ConflictView implements vscode.TreeDataProvider<ConflictItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event
  private readonly listChangedSub: vscode.Disposable

  constructor(private readonly conflictManager: ConflictManager) {
    this.listChangedSub = conflictManager.onListChanged(() => this._onDidChangeTreeData.fire())
  }

  getTreeItem(element: ConflictItem): vscode.TreeItem {
    return element
  }

  getChildren(): ConflictItem[] {
    const conflicts = this.conflictManager.getConflicts()
    if (conflicts.length === 0) {
      const empty = new vscode.TreeItem("No conflicts", vscode.TreeItemCollapsibleState.None)
      empty.iconPath = new vscode.ThemeIcon("check")
      return [empty as unknown as ConflictItem]
    }
    return conflicts.map((c) => new ConflictItem(c.docId, c.filePath))
  }

  dispose(): void {
    this.listChangedSub.dispose()
    this._onDidChangeTreeData.dispose()
  }
}
