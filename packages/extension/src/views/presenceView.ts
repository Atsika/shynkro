import * as vscode from "vscode"
import type { PresenceUser } from "@shynkro/shared"

export class PresenceItem extends vscode.TreeItem {
  readonly userId: string

  constructor(user: PresenceUser, isSelf: boolean, labelHidden = false, isFollowed = false) {
    const label = isSelf ? `${user.username} (me)` : isFollowed ? `${user.username} (following)` : user.username
    super(label, vscode.TreeItemCollapsibleState.None)
    this.userId = user.userId
    this.tooltip = `${user.userId} · ${user.role}`
    const icon = user.role === "owner" ? "star-full" : user.role === "editor" ? "edit" : "eye"
    this.iconPath = isSelf
      ? new vscode.ThemeIcon(icon, new vscode.ThemeColor("terminal.ansiGreen"))
      : new vscode.ThemeIcon(icon)
    // contextValue drives right-click menus in package.json
    if (isSelf) {
      this.contextValue = "shynkro.presence.self"
    } else {
      const followSuffix = isFollowed ? ".following" : ""
      const labelSuffix = labelHidden ? ".labelHidden" : ""
      this.contextValue = `shynkro.presence.other${labelSuffix}${followSuffix}`
    }
  }
}

export class PresenceView implements vscode.TreeDataProvider<PresenceItem> {
  private users: PresenceUser[] = []
  private selfUserId = ""
  private readonly hiddenLabels = new Set<string>()
  private followingUserId: string | null = null

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  setFollowing(userId: string | null): void {
    this.followingUserId = userId
    this._onDidChangeTreeData.fire()
  }

  setLabelHidden(userId: string, hidden: boolean): void {
    if (hidden) this.hiddenLabels.add(userId)
    else this.hiddenLabels.delete(userId)
    this._onDidChangeTreeData.fire()
  }

  updateUsers(users: PresenceUser[], selfUserId: string): void {
    // Deduplicate by userId (same account can open multiple windows)
    const seen = new Set<string>()
    this.users = users.filter((u) => {
      if (seen.has(u.userId)) return false
      seen.add(u.userId)
      return true
    })
    this.selfUserId = selfUserId
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(element: PresenceItem): vscode.TreeItem {
    return element
  }

  getChildren(): PresenceItem[] {
    if (this.users.length === 0) {
      const empty = new vscode.TreeItem("No users connected", vscode.TreeItemCollapsibleState.None)
      empty.iconPath = new vscode.ThemeIcon("info")
      return [empty as unknown as PresenceItem]
    }
    // Show self first
    const sorted = [...this.users].sort((a, b) => {
      if (a.userId === this.selfUserId) return -1
      if (b.userId === this.selfUserId) return 1
      return a.username.localeCompare(b.username)
    })
    return sorted.map((u) => new PresenceItem(u, u.userId === this.selfUserId, this.hiddenLabels.has(u.userId), u.userId === this.followingUserId))
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}
