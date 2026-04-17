import * as vscode from "vscode"
import type { ConnectionStatus } from "../types"

const ICONS: Record<ConnectionStatus, string> = {
  idle:         "$(circle-outline)",
  disconnected: "$(debug-disconnect)",
  connecting:   "$(sync~spin)",
  connected:    "$(sync)",
  syncing:      "$(sync~spin)",
}

const LABELS: Record<ConnectionStatus, string> = {
  idle:         "No workspace",
  disconnected: "Disconnected",
  connecting:   "Connecting…",
  connected:    "Connected",
  syncing:      "Syncing…",
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem
  private readonly conflictItem: vscode.StatusBarItem

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.item.name = "Shynkro"
    this.item.command = "shynkro.actionsView.focus"
    this.setStatus("idle")
    this.item.show()

    this.conflictItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99)
    this.conflictItem.name = "Shynkro Conflicts"
    // Binary conflicts only — text conflicts are auto-merged by Yjs CRDT.
    this.conflictItem.command = "shynkro.conflictView.focus"
    this.conflictItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
  }

  setStatus(status: ConnectionStatus): void {
    this.item.text = `${ICONS[status]} Shynkro: ${LABELS[status]}`
    this.item.tooltip = `Shynkro — ${LABELS[status]}`
  }

  setMessage(text: string): void {
    this.item.text = `$(sync~spin) Shynkro: ${text}`
  }

  setConflicts(n: number): void {
    if (n === 0) {
      this.conflictItem.hide()
    } else {
      this.conflictItem.text = `$(warning) ${n} conflict${n === 1 ? "" : "s"}`
      this.conflictItem.tooltip = `Shynkro: ${n} file${n === 1 ? "" : "s"} with unresolved sync conflicts`
      this.conflictItem.show()
    }
  }

  dispose(): void {
    this.item.dispose()
    this.conflictItem.dispose()
  }
}
