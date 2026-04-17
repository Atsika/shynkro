import * as path from "path"
import * as vscode from "vscode"
import type { WorkspaceId } from "@shynkro/shared"
import type { WsManager } from "../ws/wsManager"

/**
 * UI + side effects for the viewer-role experience: the status-bar warning,
 * the "request access" popup, and forcing all workspace tabs into / out of
 * VS Code's per-session read-only mode. The YjsBridge's `setRole` orchestrates
 * when to trigger these; this class owns the decoration lifecycle.
 */
export class ViewerRoleUi implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem | null = null
  private permissionPopupShown = false

  constructor(
    private readonly wsManager: WsManager,
    private readonly workspaceRoot: string,
  ) {}

  isWorkspacePath(fsPath: string): boolean {
    return fsPath === this.workspaceRoot || fsPath.startsWith(this.workspaceRoot + path.sep)
  }

  /** Call when the server demotes/promotes the user's role back to editor. */
  resetPermissionPopup(): void {
    this.permissionPopupShown = false
  }

  setStatusBarVisible(visible: boolean): void {
    if (visible) {
      if (!this.statusBarItem) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
        this.statusBarItem.text = "$(eye) Shynkro: Viewer (read-only)"
        this.statusBarItem.tooltip =
          "You are a viewer in this workspace — your edits are NOT saved to the server. Request editor access from the workspace owner."
        this.statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
      }
      this.statusBarItem.show()
    } else {
      this.statusBarItem?.hide()
    }
  }

  showPermissionRequestPopup(workspaceId: WorkspaceId): void {
    if (this.permissionPopupShown) return
    this.permissionPopupShown = true
    vscode.window.showWarningMessage(
      "You are a viewer and cannot edit this file. Request editor access?",
      "Request Access"
    ).then((choice) => {
      if (choice === "Request Access") {
        this.wsManager.sendJson({ type: "requestPermission", workspaceId })
      }
    })
  }

  lockAllTrackedEditors(): void {
    const urisToLock = this.collectWorkspaceTabUris()
    if (urisToLock.length === 0) return
    const original = vscode.window.activeTextEditor
    ;(async () => {
      for (const uri of urisToLock) {
        await vscode.window.showTextDocument(uri, { preserveFocus: false, preview: false })
        await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
      }
      if (original) {
        await vscode.window.showTextDocument(original.document, { preserveFocus: false, preview: false })
      }
    })().catch(() => {})
  }

  unlockAllTrackedEditors(): void {
    const urisToUnlock = this.collectWorkspaceTabUris()
    if (urisToUnlock.length === 0) return
    const original = vscode.window.activeTextEditor
    ;(async () => {
      for (const uri of urisToUnlock) {
        await vscode.window.showTextDocument(uri, { preserveFocus: false, preview: false })
        await vscode.commands.executeCommand("workbench.action.files.setActiveEditorWriteableInSession")
      }
      if (original) {
        await vscode.window.showTextDocument(original.document, { preserveFocus: false, preview: false })
      }
    })().catch(() => {})
  }

  private collectWorkspaceTabUris(): vscode.Uri[] {
    const seen = new Set<string>()
    const uris: vscode.Uri[] = []
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) continue
        const uri = tab.input.uri
        if (uri.scheme === "file" && this.isWorkspacePath(uri.fsPath) && !seen.has(uri.fsPath)) {
          seen.add(uri.fsPath)
          uris.push(uri)
        }
      }
    }
    return uris
  }

  dispose(): void {
    this.statusBarItem?.dispose()
    this.statusBarItem = null
  }
}
