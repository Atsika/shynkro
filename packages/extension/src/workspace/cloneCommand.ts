import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { log } from "../logger"
import { safeJoin } from "../pathUtils"
import { SHYNKRO_DIR } from "../constants"
import { writeProjectConfig } from "./projectConfig"
import { acquireLock } from "../lock/lockFile"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { AuthService } from "../auth/authService"

export async function executeClone(
  serverUrl: string,
  authService: AuthService,
  restClient: RestClient,
  makeStateDb: (dbPath: string) => StateDb,
  onSyncReady?: () => Promise<void>,
  preselectedWorkspaceId?: string
): Promise<void> {
  // Ensure logged in and token is valid against the server
  let authed = false
  const token = await authService.getValidAccessToken(serverUrl).catch(() => null)
  if (token) {
    authed = await restClient.me().then(() => true).catch(() => false)
  }
  if (!authed) {
    await authService.logout(serverUrl)
    const ok = await authService.login(serverUrl)
    if (!ok) return
  }

  // If a workspaceId was passed directly (e.g. from join command), skip selection
  if (preselectedWorkspaceId) {
    return cloneWorkspace(preselectedWorkspaceId, serverUrl, restClient, makeStateDb, onSyncReady)
  }

  const myWorkspaces = await restClient.listWorkspaces().catch(() => [])

  type PickItem = vscode.QuickPickItem & { workspaceId: string }
  const items: PickItem[] = [
    ...myWorkspaces.map((w) => ({
      label: w.name,
      description: w.id,
      workspaceId: w.id,
    })),
    {
      label: "$(add) Join by workspace ID…",
      description: "",
      detail: "Enter a workspace ID shared with you",
      workspaceId: "__join__",
    },
  ]

  const picked = await vscode.window.showQuickPick<PickItem>(items, {
    placeHolder: myWorkspaces.length > 0
      ? "Select a workspace or join a new one by ID"
      : "No workspaces found — join one by entering its ID",
    matchOnDescription: true,
  })
  if (!picked) return

  let workspaceId: string
  if (picked.workspaceId === "__join__") {
    const joined = await executeJoin(serverUrl, authService, restClient)
    if (!joined) return
    workspaceId = joined
  } else {
    workspaceId = picked.workspaceId
  }

  return cloneWorkspace(workspaceId, serverUrl, restClient, makeStateDb, onSyncReady)
}

async function cloneWorkspace(
  workspaceId: string,
  serverUrl: string,
  restClient: RestClient,
  makeStateDb: (dbPath: string) => StateDb,
  onSyncReady?: () => Promise<void>
): Promise<void> {
  const targetUri = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: "Clone into this folder",
  })
  if (!targetUri || targetUri.length === 0) return

  const targetDir = targetUri[0].fsPath

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Shynkro: cloning workspace…", cancellable: false },
    async (progress) => {
      let snapshot: Awaited<ReturnType<typeof restClient.getSnapshot>>
      try {
        snapshot = await restClient.getSnapshot(workspaceId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Shynkro: clone failed — ${msg}`)
        return
      }

      let done = 0
      try {
        for (const file of snapshot.files) {
          const localPath = safeJoin(targetDir, file.path)
          if (!localPath) {
            log.appendLine(`[clone] path traversal blocked: ${file.path}`)
            continue
          }
          fs.mkdirSync(path.dirname(localPath), { recursive: true })

          if (file.kind === "folder") {
            fs.mkdirSync(localPath, { recursive: true })
          } else if (file.kind === "text") {
            const content = await restClient.getFileContent(workspaceId, file.fileId)
            fs.writeFileSync(localPath, content, "utf-8")
          } else {
            const { data } = await restClient.downloadBlob(workspaceId, file.fileId)
            fs.writeFileSync(localPath, data)
          }

          done++
          progress.report({ message: `${done}/${snapshot.files.length} files` })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Shynkro: clone failed — ${msg}`)
        return
      }

      // Set up .shynkro/
      const shynkroDir = path.join(targetDir, SHYNKRO_DIR)
      fs.mkdirSync(shynkroDir, { recursive: true })
      if (!acquireLock(shynkroDir)) {
        vscode.window.showWarningMessage("Shynkro: another process is already using this workspace")
        return
      }

      const dbPath = path.join(shynkroDir, "state.db")
      log.appendLine(`[clone] writing ${snapshot.files.length} files to ${dbPath}`)
      const stateDb = makeStateDb(dbPath)
      stateDb.clearForRelink()
      for (const file of snapshot.files) {
        stateDb.upsertFile(file.fileId, file.path, file.kind, file.docId ?? undefined, file.hash)
      }
      log.appendLine(`[clone] stateDb now has ${stateDb.allFiles().length} files`)
      stateDb.setRevision(workspaceId, snapshot.revision)
      stateDb.close()

      writeProjectConfig(targetDir, { workspaceId, serverUrl, revision: snapshot.revision })

      const activeRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (activeRoot && path.resolve(activeRoot) === path.resolve(targetDir)) {
        vscode.window.showInformationMessage("Shynkro: workspace cloned")
        await onSyncReady?.()
      } else {
        vscode.window.showInformationMessage(
          "Shynkro: workspace cloned — open folder to start syncing",
          "Open Folder"
        ).then((choice) => {
          if (choice === "Open Folder") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(targetDir))
          }
        })
      }
    }
  )
}

/**
 * Join a workspace by ID (as viewer) and return the workspaceId,
 * or return null if the user cancelled or the workspace was not found.
 */
export async function executeJoin(
  _serverUrl: string,
  _authService: AuthService,
  restClient: RestClient,
): Promise<string | null> {
  const id = await vscode.window.showInputBox({
    title: "Join Workspace",
    prompt: "Enter the workspace ID shared with you",
    placeHolder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    validateInput: (v) => v.trim().length === 0 ? "Workspace ID cannot be empty" : undefined,
  })
  if (!id) return null
  const workspaceId = id.trim()

  let info: Awaited<ReturnType<typeof restClient.getWorkspaceInfo>>
  try {
    info = await restClient.getWorkspaceInfo(workspaceId)
  } catch {
    vscode.window.showErrorMessage("Shynkro: workspace not found — check the ID and try again")
    return null
  }

  const confirm = await vscode.window.showInformationMessage(
    `Join "${info.name}" (owned by ${info.ownerDisplayName})? You will join as a viewer.`,
    "Join", "Cancel"
  )
  if (confirm !== "Join") return null

  try {
    const result = await restClient.joinWorkspace(workspaceId)
    if (!result.alreadyMember) {
      vscode.window.showInformationMessage(`Shynkro: joined "${info.name}" as viewer`)
    }
    return workspaceId
  } catch (err) {
    vscode.window.showErrorMessage(`Shynkro: failed to join workspace — ${err}`)
    return null
  }
}
