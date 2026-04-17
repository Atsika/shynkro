import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import type { FileId, WorkspaceId } from "@shynkro/shared"
import type { ChangeReconciler } from "../sync/changeReconciler"
import type { BinarySync } from "./binarySync"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { SyncDecorationProvider } from "../views/syncDecorationProvider"
import type { BinaryConflictsView, BinaryConflictInfo } from "../views/binaryConflictsView"
import { ApiError } from "../api/restClient"
import { log } from "../logger"

interface ConflictState {
  fileId: string
  workspaceId: WorkspaceId
  localPath: string
  localHash: string
  serverHash: string
  /** QuickPick if a picker is currently visible, null if user dismissed it. */
  picker: vscode.QuickPick<vscode.QuickPickItem> | null
}

const ITEMS = {
  keepMine: "Keep mine (push to everyone)",
  keepTheirs: "Take theirs (discard local)",
  compare: "Compare side-by-side",
} as const

/**
 * Binary conflict picker. Tracks divergences in `this.active` and surfaces
 * them via the status bar count, the explorer `!` badge, and the
 * "Sync Conflicts" sidebar view. The QuickPick dialog is a *view* of one
 * conflict's state — dismissing the dialog does NOT remove the underlying
 * conflict; the user must resolve it via Keep mine / Take theirs.
 *
 * Re-trigger points:
 *  - `changeReconciler.onBinaryConflict` (rescan or WS live divergence)
 *  - `shynkro.resolveBinaryConflict` command (sidebar click, status-bar click)
 *  - `changeReconciler.onBinaryReconciled` (server moved while picker open)
 */
export class BinaryConflictPicker implements vscode.Disposable {
  private readonly active = new Map<string, ConflictState>()
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly reconciler: ChangeReconciler,
    private readonly binarySync: BinarySync,
    private readonly restClient: RestClient,
    private readonly stateDb: StateDb,
    private readonly syncDeco: SyncDecorationProvider,
    private readonly view: BinaryConflictsView,
    private readonly onConflictCountChange: (n: number) => void,
  ) {
    this.disposables.push(
      reconciler.onBinaryConflict((evt) => {
        this.registerConflict(evt.fileId, evt.workspaceId, evt.localPath, evt.localHash, evt.serverHash)
          .catch((err) => log.appendLine(`[binaryPicker] registerConflict error: ${err}`))
      }),
      reconciler.onBinaryReconciled((evt) => {
        const state = this.active.get(evt.fileId)
        if (!state) return
        this.refreshOnServerChange(state, evt.serverHash).catch((err) => {
          log.appendLine(`[binaryPicker] refresh error: ${err}`)
        })
      }),
    )
  }

  /**
   * Register a new conflict (or update an existing one with fresh hashes)
   * and show the picker. Called from the reconciler's divergence events.
   */
  private async registerConflict(
    fileId: string,
    workspaceId: WorkspaceId,
    localPath: string,
    localHash: string,
    serverHash: string,
  ): Promise<void> {
    // Coincidental match — no conflict.
    if (localHash === serverHash) {
      this.stateDb.setSyncedBinaryHash(fileId, serverHash)
      this.closeActive(fileId)
      return
    }

    const existing = this.active.get(fileId)
    if (existing) {
      existing.localHash = localHash
      existing.serverHash = serverHash
      if (existing.picker) {
        existing.picker.title = this.pickerTitle(localPath, true)
      }
      return
    }

    const state: ConflictState = {
      fileId, workspaceId, localPath, localHash, serverHash, picker: null,
    }
    this.active.set(fileId, state)
    this.syncDeco.setConflict(localPath, true)
    this.refreshView()
    this.onConflictCountChange(this.active.size)
    this.showPicker(state)
  }

  /**
   * Command target for sidebar + status bar re-open. Re-shows the picker for
   * this fileId against the latest known state. Safe to call with a stale
   * fileId — no-ops.
   */
  reopenPicker(fileId: string): void {
    const state = this.active.get(fileId)
    if (!state) return
    if (state.picker) {
      state.picker.show()
      return
    }
    this.showPicker(state)
  }

  private pickerTitle(localPath: string, serverMoved: boolean): string {
    const base = `Shynkro: conflict on ${path.basename(localPath)}`
    return serverMoved ? `${base} (server moved)` : base
  }

  private showPicker(state: ConflictState): void {
    const picker = vscode.window.createQuickPick()
    picker.title = this.pickerTitle(state.localPath, false)
    picker.placeholder = "Local and server both changed. Pick a resolution."
    picker.items = [
      { label: ITEMS.keepMine, description: "Upload your version, overwrite for everyone" },
      { label: ITEMS.keepTheirs, description: "Discard local, take server's version" },
      { label: ITEMS.compare, description: "Open both versions side by side" },
    ]
    picker.ignoreFocusOut = true
    state.picker = picker

    picker.onDidAccept(() => {
      const choice = picker.selectedItems[0]?.label
      if (!choice) return
      this.handleChoice(state, choice).catch((err) => {
        log.appendLine(`[binaryPicker] handleChoice error: ${err}`)
        vscode.window.showErrorMessage(`Shynkro: conflict resolution failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    })

    // Dismiss without choice — keep the conflict tracked, just hide the
    // dialog. Status bar and sidebar view keep showing it; user can reopen
    // via the sidebar entry or the status bar click.
    picker.onDidHide(() => {
      const currentPicker = state.picker
      state.picker = null
      currentPicker?.dispose()
    })

    picker.show()
  }

  private async handleChoice(state: ConflictState, choice: string): Promise<void> {
    if (choice === ITEMS.compare) {
      await this.openCompare(state)
      // Picker already hid (showTextDocument takes focus); re-show so the
      // user can pick after comparing.
      setTimeout(() => { if (this.active.has(state.fileId)) this.reopenPicker(state.fileId) }, 200)
      return
    }
    if (choice === ITEMS.keepMine) {
      try {
        await this.binarySync.upload(
          state.fileId as FileId,
          state.localPath,
          state.workspaceId,
          state.serverHash,
        )
        this.closeActive(state.fileId)
      } catch (err) {
        if (err instanceof ApiError && err.status === 412) {
          log.appendLine(`[binaryPicker] If-Match 412 for ${state.fileId} — re-probing`)
          await this.refreshFromServer(state)
          return
        }
        throw err
      }
      return
    }
    if (choice === ITEMS.keepTheirs) {
      await this.binarySync.download(state.fileId as FileId, state.localPath, state.workspaceId)
      this.closeActive(state.fileId)
      return
    }
  }

  private async openCompare(state: ConflictState): Promise<void> {
    const ext = path.extname(state.localPath)
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shynkro-conflict-"))
    const remoteTmp = path.join(tmpDir, `server-${state.serverHash.slice(0, 8)}${ext}`)
    try {
      const { data } = await this.restClient.downloadBlob(state.workspaceId, state.fileId as FileId)
      await fs.promises.writeFile(remoteTmp, data)
    } catch (err) {
      vscode.window.showErrorMessage(`Shynkro: couldn't fetch server version: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const localUri = vscode.Uri.file(state.localPath)
    const remoteUri = vscode.Uri.file(remoteTmp)
    const fileName = path.basename(state.localPath)
    await vscode.commands.executeCommand("vscode.diff", localUri, remoteUri, `Shynkro: ${fileName} (local ↔ server)`)
  }

  /** Refetch the server hash after a 412 and decide whether to keep the picker open. */
  private async refreshFromServer(state: ConflictState): Promise<void> {
    try {
      const probe = await this.restClient.probeBlobSize(state.workspaceId, state.fileId as FileId)
      const newServerHash = probe.hash
      if (newServerHash === state.localHash) {
        this.stateDb.setSyncedBinaryHash(state.fileId, newServerHash)
        this.closeActive(state.fileId)
        return
      }
      state.serverHash = newServerHash
      if (state.picker) state.picker.title = this.pickerTitle(state.localPath, true)
      else this.showPicker(state)
    } catch (err) {
      log.appendLine(`[binaryPicker] refreshFromServer probe failed: ${err}`)
    }
  }

  private async refreshOnServerChange(state: ConflictState, newServerHash: string): Promise<void> {
    if (newServerHash === state.serverHash) return
    // Re-read the current disk hash — the user may have replaced the local
    // file since we captured state.localHash (e.g. re-uploaded online, which
    // makes disk match server and resolves the conflict implicitly).
    let currentLocalHash = state.localHash
    try {
      currentLocalHash = await this.binarySync.computeHash(state.localPath)
    } catch { /* file missing — fall back to cached hash */ }
    if (currentLocalHash === newServerHash) {
      this.stateDb.setSyncedBinaryHash(state.fileId, newServerHash)
      this.closeActive(state.fileId)
      return
    }
    state.localHash = currentLocalHash
    state.serverHash = newServerHash
    if (state.picker) state.picker.title = this.pickerTitle(state.localPath, true)
  }

  private closeActive(fileId: string): void {
    const state = this.active.get(fileId)
    if (!state) return
    state.picker?.dispose()
    state.picker = null
    this.active.delete(fileId)
    this.syncDeco.setConflict(state.localPath, false)
    this.refreshView()
    this.onConflictCountChange(this.active.size)
  }

  private refreshView(): void {
    const list: BinaryConflictInfo[] = [...this.active.values()].map((s) => ({
      fileId: s.fileId,
      localPath: s.localPath,
    }))
    this.view.setConflicts(list)
  }

  dispose(): void {
    for (const state of this.active.values()) {
      state.picker?.dispose()
    }
    this.active.clear()
    this.disposables.forEach((d) => d.dispose())
  }
}
