import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { log } from "./logger"
import { TokenStore } from "./auth/tokenStore"
import { AuthService } from "./auth/authService"
import { RestClient } from "./api/restClient"
import { StatusBar } from "./status/statusBar"
import { WsManager } from "./ws/wsManager"
import { StateDb } from "./state/stateDb"
function makeStateDb(dbPath: string): StateDb {
  return new StateDb(dbPath)
}
import { FileWatcher } from "./sync/fileWatcher"
import { ChangeReconciler } from "./sync/changeReconciler"
import { YjsBridge } from "./yjs/yjsBridge"
import { BinarySync } from "./binary/binarySync"
import { findProjectConfig, writeProjectConfig } from "./workspace/projectConfig"
import { executeInit } from "./workspace/initCommand"
import { executeClone, executeJoin } from "./workspace/cloneCommand"
import { executeInvite } from "./workspace/inviteCommand"
import { releaseLock } from "./lock/lockFile"
import { acquireLock } from "./lock/lockFile"
import { drainPendingOps, serializePendingOpsToRecovery } from "./sync/opQueue"
import { PresenceView, PresenceItem } from "./views/presenceView"
import { ActionsView } from "./views/actionsView"
import { ConflictView } from "./views/conflictView"
import { ConflictManager } from "./conflict/conflictManager"
import { ConflictDecorations } from "./conflict/conflictDecorations"
import { ConflictLensProvider } from "./conflict/conflictLens"
import { SHYNKRO_DIR, PROJECT_JSON, EXTENSION_VERSION } from "./constants"

let stateDb: StateDb | null = null
let wsManager: WsManager | null = null
let fileWatcher: FileWatcher | null = null
let changeReconciler: ChangeReconciler | null = null
let yjsBridge: YjsBridge | null = null
let conflictManager: ConflictManager | null = null
let statusBar: StatusBar | null = null
let authService: AuthService | null = null
let lockDir: string | null = null
let shynkroDirWatcher: vscode.FileSystemWatcher | null = null
let presenceView: PresenceView | null = null
let conflictView: ConflictView | null = null

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
  log.appendLine("[activate] starting")
  const tokenStore = new TokenStore(context.secrets)
  const restClient = new RestClient(() => {
    const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
    return authService?.getValidAccessToken(serverUrl) ?? Promise.resolve(undefined)
  })

  authService = new AuthService(tokenStore, restClient)
  statusBar = new StatusBar()
  presenceView = new PresenceView()
  const actionsView = new ActionsView()
  context.subscriptions.push(
    statusBar,
    vscode.window.registerTreeDataProvider("shynkro.presenceView", presenceView),
    vscode.window.registerTreeDataProvider("shynkro.actionsView", actionsView)
  )
  // ConflictView is registered after conflictManager is created in startSync
  vscode.commands.executeCommand("setContext", "shynkro.syncActive", false)

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("shynkro.setServerUrl", async () => {
      const current = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      const input = await vscode.window.showInputBox({
        title: "Shynkro: Server URL",
        prompt: "Enter the Shynkro server address",
        value: current,
        validateInput: (v) => {
          try { new URL(v); return null } catch { return "Enter a valid URL (e.g. http://localhost:3000)" }
        },
      })
      if (!input || input === current) return

      // Test connectivity before saving
      restClient.setBaseUrl(input)
      try {
        await restClient.health()
      } catch {
        const proceed = await vscode.window.showWarningMessage(
          `Shynkro: cannot reach server at ${input}. Save anyway?`,
          { modal: true },
          "Save Anyway"
        )
        if (proceed !== "Save Anyway") {
          restClient.setBaseUrl(current)
          return
        }
      }

      await vscode.workspace.getConfiguration("shynkro").update("serverUrl", input, vscode.ConfigurationTarget.Global)
      // Also update project.json so relink picks up the new URL
      const found = findProjectConfig()
      if (found) writeProjectConfig(found.root, { ...found.config, serverUrl: input })
      if (wsManager) {
        vscode.window.showInformationMessage("Shynkro: server URL updated. Re-link the workspace to apply.", "Re-link")
          .then((choice) => { if (choice === "Re-link") vscode.commands.executeCommand("shynkro.relink") })
      } else {
        vscode.window.showInformationMessage(`Shynkro: server URL set to ${input}`)
      }
    }),

    vscode.commands.registerCommand("shynkro.login", async () => {
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)
      const ok = await authService!.login(serverUrl)
      if (ok) {
        vscode.window.showInformationMessage("Shynkro: logged in")
        const found = findProjectConfig()
        if (found) {
          restClient.setBaseUrl(found.config.serverUrl)
          startSync(found.config.serverUrl, restClient, tokenStore, context).catch(() => {})
        }
      }
    }),

    vscode.commands.registerCommand("shynkro.register", async () => {
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)
      const ok = await authService!.register(serverUrl)
      if (ok) {
        vscode.window.showInformationMessage("Shynkro: registered and logged in")
        const found = findProjectConfig()
        if (found) {
          restClient.setBaseUrl(found.config.serverUrl)
          startSync(found.config.serverUrl, restClient, tokenStore, context).catch(() => {})
        }
      }
    }),

    vscode.commands.registerCommand("shynkro.logout", async () => {
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      await authService!.logout(serverUrl)
      stopSync()
      vscode.window.showInformationMessage("Shynkro: logged out")
    }),

    vscode.commands.registerCommand("shynkro.init", async () => {
      const folders = vscode.workspace.workspaceFolders
      if (!folders) { vscode.window.showErrorMessage("Open a folder first"); return }
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)
      await executeInit(folders[0].uri.fsPath, serverUrl, authService!, restClient, makeStateDb)
      await startSync(serverUrl, restClient, tokenStore, context)
    }),

    vscode.commands.registerCommand("shynkro.clone", async () => {
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)
      await executeClone(serverUrl, authService!, restClient, makeStateDb, () =>
        startSync(serverUrl, restClient, tokenStore, context)
      )
    }),

    vscode.commands.registerCommand("shynkro.join", async () => {
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)
      const token = await authService!.getValidAccessToken(serverUrl).catch(() => null)
      if (!token) {
        const ok = await authService!.login(serverUrl)
        if (!ok) return
      }
      const workspaceId = await executeJoin(serverUrl, authService!, restClient)
      if (!workspaceId) return
      // After joining, offer to download the files (same flow as clone)
      await executeClone(serverUrl, authService!, restClient, makeStateDb, () =>
        startSync(serverUrl, restClient, tokenStore, context),
        workspaceId
      )
    }),

    vscode.commands.registerCommand("shynkro.invite", async () => {
      const found = findProjectConfig()
      if (!found) {
        vscode.window.showErrorMessage("Shynkro: no active workspace — init or clone a workspace first")
        return
      }
      await executeInvite(found.config.workspaceId, restClient)
    }),

    vscode.commands.registerCommand("shynkro.copyWorkspaceId", async () => {
      const found = findProjectConfig()
      if (!found) {
        vscode.window.showErrorMessage("Shynkro: no active workspace")
        return
      }
      await vscode.env.clipboard.writeText(found.config.workspaceId)
      vscode.window.showInformationMessage(`Shynkro: workspace ID copied to clipboard`)
    }),

    vscode.commands.registerCommand("shynkro.member.changeRole", async (item: PresenceItem) => {
      const found = findProjectConfig()
      if (!found) return
      const role = await vscode.window.showQuickPick(
        [{ label: "Editor", description: "Can edit files", value: "editor" as const },
         { label: "Viewer", description: "Read-only", value: "viewer" as const }],
        { placeHolder: `Select new role for ${item.label}` }
      )
      if (!role) return
      try {
        await restClient.updateMemberRole(found.config.workspaceId, item.userId, role.value)
        vscode.window.showInformationMessage(`Shynkro: role updated to ${role.value}`)
      } catch (err) {
        vscode.window.showErrorMessage(`Shynkro: failed to change role — ${err}`)
      }
    }),

    vscode.commands.registerCommand("shynkro.member.remove", async (item: PresenceItem) => {
      const found = findProjectConfig()
      if (!found) return
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${item.label} from this workspace?`, { modal: true }, "Remove"
      )
      if (confirm !== "Remove") return
      try {
        await restClient.removeMember(found.config.workspaceId, item.userId)
        vscode.window.showInformationMessage(`Shynkro: member removed`)
      } catch (err) {
        vscode.window.showErrorMessage(`Shynkro: failed to remove member — ${err}`)
      }
    }),

    vscode.commands.registerCommand("shynkro.member.hideCursorLabel", (item: PresenceItem) => {
      yjsBridge?.setLabelHidden(item.userId, true)
      presenceView?.setLabelHidden(item.userId, true)
    }),

    vscode.commands.registerCommand("shynkro.member.showCursorLabel", (item: PresenceItem) => {
      yjsBridge?.setLabelHidden(item.userId, false)
      presenceView?.setLabelHidden(item.userId, false)
    }),

    vscode.commands.registerCommand("shynkro.member.follow", (item: PresenceItem) => {
      yjsBridge?.startFollowing(item.userId)
      presenceView?.setFollowing(item.userId)
    }),

    vscode.commands.registerCommand("shynkro.member.unfollow", (_item: PresenceItem) => {
      yjsBridge?.stopFollowing()
      presenceView?.setFollowing(null)
    }),

    vscode.commands.registerCommand("shynkro.deleteWorkspace", async () => {
      let workspaces: Awaited<ReturnType<typeof restClient.listWorkspaces>>
      let me: Awaited<ReturnType<typeof restClient.me>>
      try {
        ;[workspaces, me] = await Promise.all([restClient.listWorkspaces(), restClient.me()])
      } catch (err) {
        vscode.window.showErrorMessage(`Shynkro: failed to fetch workspaces — ${err}`)
        return
      }

      const owned = workspaces.filter(w => w.ownerId === me.id)
      if (owned.length === 0) {
        vscode.window.showInformationMessage("Shynkro: you don't own any workspaces")
        return
      }

      const currentConfig = findProjectConfig()
      const picked = await vscode.window.showQuickPick(
        owned.map(w => ({
          label: w.name,
          description: w.id === currentConfig?.config.workspaceId ? "(current)" : undefined,
          id: w.id,
        })),
        { placeHolder: "Select a workspace to delete" }
      )
      if (!picked) return

      const confirm = await vscode.window.showWarningMessage(
        `Delete workspace "${picked.label}" from the server? All members will lose access and sync will stop. Local files are kept.`,
        { modal: true },
        "Delete Workspace"
      )
      if (confirm !== "Delete Workspace") return

      // Stop sync before the API call so the wsManager is disposed before
      // the server's broadcastToWorkspace fires — otherwise the WS event
      // arrives before the HTTP response and triggers a duplicate notification.
      const isDeletingCurrent = currentConfig != null && picked.id === currentConfig.config.workspaceId
      if (isDeletingCurrent) {
        stopSync()
        try { fs.rmSync(path.join(currentConfig!.root, SHYNKRO_DIR, PROJECT_JSON)) } catch {}
      }

      try {
        await restClient.deleteWorkspace(picked.id)
      } catch (err) {
        vscode.window.showErrorMessage(`Shynkro: failed to delete workspace — ${err}`)
        return
      }

      if (isDeletingCurrent) {
        const choice = await vscode.window.showInformationMessage(
          "Workspace deleted. Your local files are intact. Create a new workspace from them?",
          "Create New Workspace"
        )
        if (choice === "Create New Workspace") {
          vscode.commands.executeCommand("shynkro.init")
        }
      } else {
        vscode.window.showInformationMessage(`Shynkro: workspace "${picked.label}" deleted`)
      }
    }),

    vscode.commands.registerCommand("shynkro.acceptLocalHunk", (docId?: string, hunkIndex?: number) => {
      if (docId != null && hunkIndex != null) {
        conflictManager?.resolveHunk(docId, hunkIndex, "local")
      } else {
        conflictManager?.resolveHunkAtCursor(docId, "local")
      }
    }),

    vscode.commands.registerCommand("shynkro.acceptServerHunk", (docId?: string, hunkIndex?: number) => {
      if (docId != null && hunkIndex != null) {
        conflictManager?.resolveHunk(docId, hunkIndex, "server")
      } else {
        conflictManager?.resolveHunkAtCursor(docId, "server")
      }
    }),

    vscode.commands.registerCommand("shynkro.relink", async () => {
      const found = findProjectConfig()
      if (!found) { vscode.window.showErrorMessage("Shynkro: no project.json found in this workspace"); return }

      const { root: workspaceRoot, config } = found
      stopSync()

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Shynkro: re-linking workspace…", cancellable: false },
        async () => {
          try {
            const serverUrl = config.serverUrl
            restClient.setBaseUrl(serverUrl)
            const snapshot = await restClient.getSnapshot(config.workspaceId)

            const shynkroDir = path.join(workspaceRoot, SHYNKRO_DIR)
            fs.mkdirSync(shynkroDir, { recursive: true })
            const dbPath = path.join(shynkroDir, "state.db")

            // Rebuild stateDb from snapshot
            const db = makeStateDb(dbPath)
            db.clearForRelink()
            for (const file of snapshot.files) {
              db.upsertFile(file.fileId, file.path, file.kind, file.docId ?? undefined, file.hash)
            }
            db.setRevision(config.workspaceId, snapshot.revision)
            db.close()

            vscode.window.showInformationMessage("Shynkro: workspace re-linked. Restarting sync…")
            await startSync(serverUrl, restClient, tokenStore, context)
          } catch (err) {
            vscode.window.showErrorMessage(`Shynkro: re-link failed: ${err}`)
          }
        }
      )
    })
  )

  // Auto-detect on activate
  const found = findProjectConfig()
  log.appendLine(`[activate] findProjectConfig=${found ? found.root : "null"}`)
  if (found) {
    const serverUrl = found.config.serverUrl
    restClient.setBaseUrl(serverUrl)

    // Ensure we have a token before starting sync
    const token = await authService.getValidAccessToken(serverUrl).catch(() => undefined)
    log.appendLine(`[activate] token=${token ? "present" : "missing"}`)
    if (!token) {
      const choice = await vscode.window.showInformationMessage(
        "Shynkro: this workspace is linked to a Shynkro server. Log in to start syncing.",
        "Login", "Register"
      )
      log.appendLine(`[activate] login prompt choice=${choice ?? "dismissed"}`)
      if (choice === "Login") {
        const ok = await authService.login(serverUrl)
        if (!ok) { log.appendLine("[activate] login cancelled"); return }
      } else if (choice === "Register") {
        const ok = await authService.register(serverUrl)
        if (!ok) { log.appendLine("[activate] register cancelled"); return }
      } else {
        log.appendLine("[activate] user dismissed login prompt, not syncing")
        return
      }
    }

    startSync(serverUrl, restClient, tokenStore, context).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      log.appendLine(`[activate] startSync failed: ${msg}`)
    })
  }

  // Open Yjs docs for visible text editors
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        maybeBridgeEditor(editor)
      }
    })
  )
  log.appendLine("[activate] done")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.appendLine(`[activate] FATAL ERROR: ${msg}`)
    vscode.window.showErrorMessage(`Shynkro failed to activate: ${msg}`)
  }
}

function semverGte(a: string, b: string): boolean {
  const parse = (v: string) => v.split(".").map(Number)
  const [aMaj, aMin, aPat] = parse(a)
  const [bMaj, bMin, bPat] = parse(b)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPat >= bPat
}

async function startSync(
  serverUrl: string,
  restClient: RestClient,
  _tokenStore: TokenStore,
  context: vscode.ExtensionContext
): Promise<void> {
  const found = findProjectConfig()
  if (!found) return

  // Health check: verify server is reachable and extension version is compatible
  try {
    const health = await restClient.health()
    if (!semverGte(EXTENSION_VERSION, health.minExtensionVersion)) {
      const msg = `Shynkro: server requires extension >= ${health.minExtensionVersion} (you have ${EXTENSION_VERSION}). Please update the extension.`
      vscode.window.showErrorMessage(msg)
      log.appendLine(`[sync] ${msg}`)
      return
    }
    log.appendLine(`[sync] health check ok, apiVersion=${health.apiVersion}`)
  } catch (err) {
    // Server unreachable — WsManager will reconnect and retry
    log.appendLine(`[sync] health check failed (server may be starting): ${err}`)
  }

  const { root: workspaceRoot, config } = found

  const shynkroDir = path.join(workspaceRoot, SHYNKRO_DIR)
  if (!acquireLock(shynkroDir)) {
    log.appendLine("[sync] acquireLock failed — another window is already syncing")
    vscode.window.showWarningMessage("Shynkro: another window is already syncing this workspace")
    return
  }
  lockDir = shynkroDir
  log.appendLine(`[sync] lock acquired at ${shynkroDir}`)

  const dbPath = path.join(shynkroDir, "state.db")
  log.appendLine(`[sync] opening stateDb at ${dbPath}`)
  stateDb = makeStateDb(dbPath)
  // Pass stateDb so pending Yjs frames persist across extension reloads (B2).
  wsManager = new WsManager(authService!, statusBar!, stateDb)
  fileWatcher = new FileWatcher(workspaceRoot, config.workspaceId, stateDb, restClient, wsManager)
  const binarySync = new BinarySync(restClient, stateDb, workspaceRoot, fileWatcher)
  changeReconciler = new ChangeReconciler(
    config.workspaceId, workspaceRoot, stateDb, restClient, fileWatcher,
    binarySync
  )

  const conflictDecorations = new ConflictDecorations()
  const conflictLensProvider = new ConflictLensProvider()
  conflictManager = new ConflictManager(
    (n) => {
      statusBar?.setConflicts(n)
      vscode.commands.executeCommand("setContext", "shynkro.hasActiveConflict", n > 0)
    },
    conflictDecorations,
    conflictLensProvider
  )
  yjsBridge = new YjsBridge(wsManager, fileWatcher, conflictManager, stateDb, workspaceRoot)

  // Register conflict view now that conflictManager is available
  conflictView?.dispose()
  conflictView = new ConflictView(conflictManager)
  context.subscriptions.push(
    conflictDecorations,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, conflictLensProvider),
    vscode.window.registerTreeDataProvider("shynkro.conflictView", conflictView)
  )

  // Wire WS events
  changeReconciler.wireWsEvents(wsManager.onServerMessage)

  // Wire binary file changes
  context.subscriptions.push(
    fileWatcher.onBinaryChanged(({ fileId, localPath }) => {
      binarySync.upload(fileId, localPath, config.workspaceId).catch((e) => log.appendLine(`[sync] binarySync.upload error: ${e}`))
    })
  )

  // Wire external text file edits (e.g. vim) → Yjs ops
  context.subscriptions.push(
    fileWatcher.onTextFileChangedExternally(({ filePath, docId }) => {
      yjsBridge?.handleExternalTextEdit(filePath, docId)
    })
  )

  // Wire file deletions to the Yjs bridge so open editor tabs get closed and
  // their Yjs doc subscriptions torn down. Without this, the editor stays open
  // and every subsequent keystroke is silently dropped by the server.
  context.subscriptions.push(
    fileWatcher.onFileDeleted(({ absPath }) => {
      yjsBridge?.handleFileDeleted(absPath, { remote: false }).catch((err) =>
        log.appendLine(`[sync] handleFileDeleted (local) error: ${err}`)
      )
    }),
    changeReconciler.onRemoteFileDeleted(({ absPath }) => {
      yjsBridge?.handleFileDeleted(absPath, { remote: true }).catch((err) =>
        log.appendLine(`[sync] handleFileDeleted (remote) error: ${err}`)
      )
    })
  )

  // Helper: bridge to editor if open, otherwise subscribe as background
  const bridgeOrBackground = (fsPath: string) => {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === fsPath) {
        maybeBridgeEditor(editor)
        return
      }
    }
    const relPath = vscode.workspace.asRelativePath(vscode.Uri.file(fsPath), false)
    const row = stateDb?.getFileByPath(relPath)
    if (row?.docId && yjsBridge) {
      yjsBridge.subscribeBackground(row.docId, config.workspaceId, fsPath)
    }
  }

  // When window A creates a file locally: bridge editor or subscribe background
  context.subscriptions.push(
    fileWatcher.onTextFileRegistered((fsPath) => bridgeOrBackground(fsPath))
  )

  // When window B receives a fileCreated event from the server: bridge editor or subscribe background
  context.subscriptions.push(
    changeReconciler.onTextFileRegistered((fsPath) => bridgeOrBackground(fsPath))
  )

  // Wire permission / membership / presence events
  context.subscriptions.push(
    wsManager.onServerMessage((msg) => {
      if (msg.type === "workspaceDeleted") {
        stopSync()
        // Unlink the folder so reconnection attempts don't loop
        try { fs.rmSync(path.join(workspaceRoot, SHYNKRO_DIR, PROJECT_JSON)) } catch {}
        vscode.window.showWarningMessage(
          "Shynkro: this workspace has been deleted. Your local files are intact.",
          "Create New Workspace"
        ).then((choice) => {
          if (choice === "Create New Workspace") vscode.commands.executeCommand("shynkro.init")
        })
      } else if (msg.type === "memberRemoved") {
        // Try one last drain so any queued offline ops land on the server before
        // the membership is fully revoked. Whatever the server refuses (or whatever
        // fails transiently) gets serialized to a recovery JSON the user can open
        // later — prevents silent loss of unsynced work on abrupt removal.
        (async () => {
          if (stateDb) {
            try {
              await drainPendingOps(stateDb, restClient, config.workspaceId, workspaceRoot)
            } catch (err) {
              log.appendLine(`[sync] memberRemoved final drain error: ${err}`)
            }
            const recoveryPath = serializePendingOpsToRecovery(stateDb, workspaceRoot)
            if (recoveryPath) {
              vscode.window.showWarningMessage(
                `Shynkro: you have been removed from this workspace. Unsynced changes were saved to ${path.basename(recoveryPath)}.`,
                "Reveal Recovery File"
              ).then((choice) => {
                if (choice === "Reveal Recovery File") {
                  vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(recoveryPath))
                }
              })
            } else {
              vscode.window.showWarningMessage("Shynkro: you have been removed from this workspace. Sync stopped.")
            }
          } else {
            vscode.window.showWarningMessage("Shynkro: you have been removed from this workspace. Sync stopped.")
          }
          stopSync()
        })().catch((err) => {
          log.appendLine(`[sync] memberRemoved handler error: ${err}`)
          stopSync()
        })
      } else if (msg.type === "permissionChanged") {
        if (msg.userId === wsManager!.userId) {
          yjsBridge?.setRole(msg.role)
          vscode.window.showInformationMessage(`Shynkro: your role has changed to ${msg.role}.`)
        }
      } else if (msg.type === "permissionRequested") {
        vscode.window.showInformationMessage(
          `${msg.requesterName} is requesting editor access.`,
          "Accept", "Deny"
        ).then(async (choice) => {
          if (choice === "Accept") {
            try {
              await restClient.updateMemberRole(msg.workspaceId, msg.requesterId, "editor")
            } catch (err) {
              vscode.window.showErrorMessage(`Shynkro: failed to grant access: ${err}`)
            }
          }
        })
      } else if (msg.type === "presenceUpdate") {
        presenceView?.updateUsers(msg.users, wsManager!.userId)
        const followedId = yjsBridge?.followedUserId
        if (followedId && !msg.users.some((u) => u.userId === followedId)) {
          yjsBridge?.stopFollowing()
          presenceView?.setFollowing(null)
          vscode.window.showInformationMessage("Shynkro: user you were following has left")
        }
      }
    })
  )

  // Wire status changes
  let hasConnectedOnce = false
  context.subscriptions.push(
    wsManager.onStatusChange((status) => {
      if (status === "connected") {
        const isReconnect = hasConnectedOnce
        hasConnectedOnce = true
        log.appendLine(`[sync] WS connected (reconnect=${isReconnect}), stateDb files: ${JSON.stringify(stateDb?.allFiles())}`)
        log.appendLine(`[sync] WS connected, bridging ${vscode.window.visibleTextEditors.length} visible editors`)

        // Drain any ops queued while offline, then reconcile
        drainPendingOps(stateDb!, restClient, config.workspaceId, workspaceRoot)
          .then((created) => {
            for (const f of created) {
              bridgeOrBackground(path.join(workspaceRoot, f.path))
            }
          })
          .catch(() => {})
          .finally(() => {
            changeReconciler?.reconcile().catch((err) => {
              log.appendLine(`[sync] reconcile error: ${err}`)
            })
          })

        changeReconciler?.startPolling()

        // Fetch own role so viewer enforcement is accurate from the start
        restClient.listMembers(config.workspaceId).then((members) => {
          const self = members.find((m) => m.userId === wsManager!.userId)
          if (self) yjsBridge?.setRole(self.role)
        }).catch(() => {})

        // Pass username to the bridge so it appears on remote cursor labels
        restClient.me().then((me) => yjsBridge?.setUsername(me.username)).catch(() => {})

        if (isReconnect) {
          // On reconnect: re-subscribe docs that were already open before disconnect
          yjsBridge?.notifyConnected(config.workspaceId)
        } else {
          // First connect: bridge visible editors and subscribe background docs
          for (const editor of vscode.window.visibleTextEditors) {
            maybeBridgeEditor(editor)
          }
          for (const file of stateDb?.allFiles() ?? []) {
            if (file.kind === "text" && file.docId) {
              const filePath = path.join(workspaceRoot, file.path)
              yjsBridge?.subscribeBackground(file.docId, config.workspaceId, filePath)
            }
          }
        }
      } else if (status === "disconnected") {
        changeReconciler?.stopPolling()
      }
    })
  )

  fileWatcher.start()
  wsManager.connect(serverUrl, config.workspaceId)
  vscode.commands.executeCommand("setContext", "shynkro.syncActive", true)

  // Watch for .shynkro deletion — stop sync if removed
  const shynkroPattern = new vscode.RelativePattern(workspaceRoot, SHYNKRO_DIR)
  shynkroDirWatcher = vscode.workspace.createFileSystemWatcher(shynkroPattern, true, true, false)
  shynkroDirWatcher.onDidDelete(() => {
    log.appendLine("[sync] .shynkro directory deleted, stopping sync")
    stopSync()
    vscode.window.showInformationMessage("Shynkro: workspace unlinked (.shynkro deleted)")
  })
}

function stopSync(): void {
  conflictView?.dispose()
  conflictView = null
  conflictManager?.dispose()
  conflictManager = null
  yjsBridge?.dispose()
  yjsBridge = null
  changeReconciler?.dispose()
  changeReconciler = null
  fileWatcher?.dispose()
  fileWatcher = null
  wsManager?.dispose()
  wsManager = null
  stateDb?.close()
  stateDb = null
  shynkroDirWatcher?.dispose()
  shynkroDirWatcher = null
  if (lockDir) {
    releaseLock(lockDir)
    lockDir = null
  }
  statusBar?.setStatus("idle")
  presenceView?.updateUsers([], "")
  presenceView?.setFollowing(null)
  vscode.commands.executeCommand("setContext", "shynkro.syncActive", false)
  log.appendLine("[sync] stopped")
}

function maybeBridgeEditor(editor: vscode.TextEditor): void {
  if (!yjsBridge || !stateDb) return
  // Only bridge file:// URIs — skip output channels, untitled docs, etc.
  if (editor.document.uri.scheme !== "file") return
  const found = findProjectConfig()
  if (!found) return

  const relPath = vscode.workspace.asRelativePath(editor.document.uri, false)
  const row = stateDb.getFileByPath(relPath)
  log.appendLine(`[bridge] ${relPath} → row=${JSON.stringify(row)}`)
  if (!row || row.kind !== "text" || !row.docId) return

  yjsBridge.openDoc(
    row.fileId as import("@shynkro/shared").FileId,
    row.docId as import("@shynkro/shared").DocId,
    found.config.workspaceId,
    editor.document.uri.fsPath,
    editor
  )
}

export function deactivate(): void {
  stopSync()
  authService?.dispose()
  log.appendLine("[deactivate] done")
}
