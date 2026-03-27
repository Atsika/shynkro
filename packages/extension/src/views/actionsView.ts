import * as vscode from "vscode"

/**
 * Empty tree provider — never returns items. The sidebar buttons are rendered
 * via `viewsWelcome` in package.json (the standard VS Code way for action panels).
 */
export class ActionsView implements vscode.TreeDataProvider<never> {
  getTreeItem(): vscode.TreeItem {
    throw new Error("unreachable")
  }

  getChildren(): never[] {
    return []
  }

  dispose(): void {}
}
