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
import { ApiError } from "../api/restClient"
import { log } from "../logger"

interface ConflictState {
  fileId: string
  workspaceId: WorkspaceId
  localPath: string
  /** Hash on disk at the moment we opened (or re-opened) the picker. */
  localHash: string
  /** Hash currently on the server at the moment we opened the picker. */
  serverHash: string
  picker: vscode.QuickPick<vscode.QuickPickItem>
  /** Set true after the user picks something so async result handlers don't re-trigger UI on dispose. */
  resolved: boolean
}

const ITEMS = {
  keepMine: "Keep mine (push to everyone)",
  keepTheirs: "Take theirs (discard local)",
  compare: "Compare side-by-side",
} as const

/**
 * Live binary conflict picker. Wires `ChangeReconciler.onBinaryConflict` to a
 * VS Code QuickPick. Only the user(s) whose local copy diverged see UI;
 * everyone else gets a silent download via `applyBinaryUpdated`'s default
 * branch.
 *
 * Live behavior: while a picker is open, an `onBinaryReconciled` event for the
 * same fileId disposes the current picker and re-evaluates against the new
 * server state — auto-dismissing if local now matches, or re-opening with the
 * winner's version as "theirs" otherwise.
 *
 * Concurrency: "Keep mine" sends `If-Match: <opened-time serverHash>`. A 412
 * from the server means another resolver pushed first; we re-evaluate.
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
    private readonly onConflictCountChange: (n: number) => void,
  ) {
    this.disposables.push(
      reconciler.onBinaryConflict((evt) => {
        this.openOrRefresh(evt.fileId, evt.workspaceId, evt.localPath, evt.localHash, evt.serverHash).catch((err) => {
          log.appendLine(`[binaryPicker] openOrRefresh error: ${err}`)
        })
      }),
      reconciler.onBinaryReconciled((evt) => {
        const state = this.active.get(evt.fileId)
        if (!state) return
        // Server moved while our picker was open — refresh against the new state.
        this.refreshOnServerChange(state, evt.serverHash).catch((err) => {
          log.appendLine(`[binaryPicker] refresh error: ${err}`)
        })
      }),
    )
  }

  private async openOrRefresh(
    fileId: string,
    workspaceId: WorkspaceId,
    localPath: string,
    localHash: string,
    serverHash: string,
  ): Promise<void> {
    // Auto-dismiss path: if local already matches the new server hash, we
    // don't even need to ask.
    if (localHash === serverHash) {
      this.stateDb.setSyncedBinaryHash(fileId, serverHash)
      this.closeActive(fileId)
      return
    }

    const existing = this.active.get(fileId)
    if (existing) {
      // Update the in-flight state and reopen against the new server hash.
      existing.serverHash = serverHash
      existing.localHash = localHash
      existing.picker.title = `Shynkro: conflict on ${path.basename(localPath)} (server moved)`
      return
    }

    const fileName = path.basename(localPath)
    const picker = vscode.window.createQuickPick()
    picker.title = `Shynkro: conflict on ${fileName}`
    picker.placeholder = "Local and server both changed. Pick a resolution."
    picker.items = [
      { label: ITEMS.keepMine, description: "Upload your version, overwrite for everyone" },
      { label: ITEMS.keepTheirs, description: "Discard local, take server's version" },
      { label: ITEMS.compare, description: "Open both versions side by side" },
    ]
    picker.ignoreFocusOut = true

    const state: ConflictState = {
      fileId, workspaceId, localPath, localHash, serverHash, picker, resolved: false,
    }
    this.active.set(fileId, state)
    this.syncDeco.setConflict(localPath, true)
    this.onConflictCountChange(this.active.size)

    picker.onDidAccept(() => {
      const choice = picker.selectedItems[0]?.label
      if (!choice) return
      this.handleChoice(state, choice).catch((err) => {
        log.appendLine(`[binaryPicker] handleChoice error: ${err}`)
        vscode.window.showErrorMessage(`Shynkro: conflict resolution failed: ${err instanceof Error ? err.message : String(err)}`)
        this.closeActive(fileId)
      })
    })

    picker.onDidHide(() => {
      // Hide without accept = dismiss. Only clean up if not already resolved
      // (i.e., user closed it manually).
      if (!state.resolved) {
        this.active.delete(fileId)
        this.syncDeco.setConflict(localPath, false)
        this.onConflictCountChange(this.active.size)
      }
    })

    picker.show()
  }

  private async handleChoice(state: ConflictState, choice: string): Promise<void> {
    if (choice === ITEMS.compare) {
      await this.openCompare(state)
      return // leave picker open
    }
    if (choice === ITEMS.keepMine) {
      try {
        await this.binarySync.upload(
          state.fileId as FileId,
          state.localPath,
          state.workspaceId,
          state.serverHash, // If-Match: server hash at open time
        )
        state.resolved = true
        this.closeActive(state.fileId)
      } catch (err) {
        if (err instanceof ApiError && err.status === 412) {
          // Server moved between picker-open and our PUT — fetch the new hash
          // and re-open the picker against it.
          log.appendLine(`[binaryPicker] If-Match 412 for ${state.fileId} — server moved, refreshing`)
          await this.refreshFromServer(state)
          return
        }
        throw err
      }
      return
    }
    if (choice === ITEMS.keepTheirs) {
      await this.binarySync.download(state.fileId as FileId, state.localPath, state.workspaceId)
      state.resolved = true
      this.closeActive(state.fileId)
      return
    }
  }

  private async openCompare(state: ConflictState): Promise<void> {
    // Stage server's blob to a temp file we can hand to vscode.diff.
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
    // For text-diffable types vscode.diff renders an inline diff; for images
    // and other binaries VS Code falls back to its built-in viewers. Either
    // way the user sees both sides.
    await vscode.commands.executeCommand("vscode.diff", localUri, remoteUri, `Shynkro: ${fileName} (local ↔ server)`)
  }

  /** Re-fetch the current server hash and decide whether to keep the picker open. */
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
      state.picker.title = `Shynkro: conflict on ${path.basename(state.localPath)} (server moved)`
    } catch (err) {
      log.appendLine(`[binaryPicker] refreshFromServer probe failed: ${err}`)
    }
  }

  private async refreshOnServerChange(state: ConflictState, newServerHash: string): Promise<void> {
    if (newServerHash === state.serverHash) return // no real change
    if (newServerHash === state.localHash) {
      this.stateDb.setSyncedBinaryHash(state.fileId, newServerHash)
      this.closeActive(state.fileId)
      return
    }
    state.serverHash = newServerHash
    state.picker.title = `Shynkro: conflict on ${path.basename(state.localPath)} (server moved)`
  }

  private closeActive(fileId: string): void {
    const state = this.active.get(fileId)
    if (!state) return
    state.resolved = true
    state.picker.dispose()
    this.active.delete(fileId)
    this.syncDeco.setConflict(state.localPath, false)
    this.onConflictCountChange(this.active.size)
  }

  dispose(): void {
    for (const state of this.active.values()) {
      state.picker.dispose()
    }
    this.active.clear()
    this.disposables.forEach((d) => d.dispose())
  }
}
