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
import { FileWatcher } from "./sync/fileWatcher"
import { ChangeReconciler } from "./sync/changeReconciler"
import { YjsBridge } from "./yjs/yjsBridge"
import { BinarySync } from "./binary/binarySync"
import { ChunkedUploader } from "./binary/chunkedUpload"
import { ChunkedDownloader } from "./binary/chunkedDownload"
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
import { SyncDecorationProvider } from "./views/syncDecorationProvider"
import { SHYNKRO_DIR, PROJECT_JSON, EXTENSION_VERSION } from "./constants"
import { classifyFile, classifyFileWithContent } from "@shynkro/shared"
import { decodeTextFile } from "./text/textNormalize"

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
let binarySyncInstance: BinarySync | null = null
let syncDecoProviderInstance: SyncDecorationProvider | null = null
let syncDecoRegistration: vscode.Disposable | null = null

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

  // Detect whether the user is already logged in (has a valid token from a
  // previous session) so the command palette shows the right button from the
  // start: "Login / Register" when logged out, "Logout" when logged in.
  const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
  // Gate on the refresh token (long-lived) rather than the access token
  // (15 min). A user whose access token expired while VS Code was closed still
  // has valid credentials; auto-refresh will get them a fresh access token on
  // the next request.
  const hasCredentials = await authService.hasCredentials(serverUrl)
  vscode.commands.executeCommand("setContext", "shynkro.loggedIn", hasCredentials)

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

    // Login / Register: single command that shows a quick-pick. Visible only
    // when NOT logged in (shynkro.loggedIn == false).
    vscode.commands.registerCommand("shynkro.login", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: "$(sign-in) Login", description: "Sign in with an existing account", action: "login" as const },
          { label: "$(person-add) Register", description: "Create a new account", action: "register" as const },
        ],
        { title: "Shynkro: Login / Register", placeHolder: "Choose an option" }
      )
      if (!choice) return

      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)

      let ok = false
      if (choice.action === "login") {
        ok = await authService!.login(serverUrl)
        if (ok) vscode.window.showInformationMessage("Shynkro: logged in")
      } else {
        ok = await authService!.register(serverUrl)
        if (ok) vscode.window.showInformationMessage("Shynkro: registered and logged in")
      }
      vscode.commands.executeCommand("setContext", "shynkro.loggedIn", ok)
      if (ok) {
        const found = findProjectConfig()
        if (found) {
          restClient.setBaseUrl(found.config.serverUrl)
          startSync(found.config.serverUrl, restClient, tokenStore, context).catch(() => {})
        }
      }
    }),

    // Logout: visible only when logged in (shynkro.loggedIn == true).
    vscode.commands.registerCommand("shynkro.logout", async () => {
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      await authService!.logout(serverUrl)
      stopSync()
      vscode.commands.executeCommand("setContext", "shynkro.loggedIn", false)
      vscode.window.showInformationMessage("Shynkro: logged out")
    }),

    // Keep the register command as a no-op alias so the activation event
    // in package.json doesn't break. It just forwards to the login quick-pick.
    vscode.commands.registerCommand("shynkro.register", () => {
      vscode.commands.executeCommand("shynkro.login")
    }),

    // Track / Untrack: right-click context menu on files in the explorer.
    vscode.commands.registerCommand("shynkro.trackFile", async (uri: vscode.Uri) => {
      if (!uri || !stateDb || !wsManager?.connected) {
        vscode.window.showWarningMessage("Shynkro: sync must be active to track files.")
        return
      }
      const found = findProjectConfig()
      if (!found) return
      const relPath = path.relative(found.root, uri.fsPath).replace(/\\/g, "/")

      // Already tracked?
      if (stateDb.getFileByPath(relPath)) {
        vscode.window.showInformationMessage(`Shynkro: "${path.basename(relPath)}" is already tracked.`)
        return
      }

      // Case-insensitive collision check
      const ciCollision = stateDb.getFileByPathCI(relPath)
      if (ciCollision && ciCollision.path !== relPath) {
        vscode.window.showWarningMessage(
          `Shynkro: cannot track "${path.basename(relPath)}" — "${path.basename(ciCollision.path)}" already exists (case-insensitive match).`
        )
        return
      }

      let stat: fs.Stats
      try {
        stat = fs.lstatSync(uri.fsPath)
      } catch {
        vscode.window.showErrorMessage(`Shynkro: file not found: ${relPath}`)
        return
      }
      if (stat.isSymbolicLink()) {
        vscode.window.showWarningMessage("Shynkro: symlinks cannot be tracked.")
        return
      }

      // classifyFile + classifyFileWithContent imported at module top
      let kind = stat.isDirectory() ? "folder" as const : classifyFile(uri.fsPath)
      if (kind === null) {
        try {
          const fd = fs.openSync(uri.fsPath, "r")
          try {
            const sniff = Buffer.alloc(Math.min(4096, stat.size))
            if (sniff.length > 0) fs.readSync(fd, sniff, 0, sniff.length, 0)
            kind = classifyFileWithContent(uri.fsPath, sniff)
          } finally {
            fs.closeSync(fd)
          }
        } catch {
          kind = "text"
        }
      }

      let content: string | undefined
      if (kind === "text") {
        try {
          const decoded = decodeTextFile(fs.readFileSync(uri.fsPath, "utf-8"))
          content = decoded.content
        } catch { /* fall through — content stays undefined */ }
      }

      const mode = process.platform !== "win32" && stat.isFile() ? (stat.mode & 0o777) : undefined

      try {
        const file = await restClient.createFile(found.config.workspaceId, {
          path: relPath,
          kind,
          content,
          mode,
        })
        stateDb.upsertFile(file.id, relPath, kind, file.docId ?? undefined)
        if (mode !== undefined) stateDb.setFileMode(file.id, mode)
        vscode.window.showInformationMessage(`Shynkro: now tracking "${path.basename(relPath)}"`)
        log.appendLine(`[track] tracked ${relPath} id=${file.id}`)
        syncDecoProviderInstance?.refresh([uri])

        if (kind === "binary" && binarySyncInstance) {
          binarySyncInstance.upload(
            file.id as import("@shynkro/shared").FileId,
            uri.fsPath,
            found.config.workspaceId
          ).catch((e) => log.appendLine(`[track] binary upload error: ${e}`))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Shynkro: failed to track "${path.basename(relPath)}" — ${msg}`)
      }
    }),

    vscode.commands.registerCommand("shynkro.untrackFile", async (uri: vscode.Uri) => {
      if (!uri || !stateDb || !wsManager?.connected) {
        vscode.window.showWarningMessage("Shynkro: sync must be active to untrack files.")
        return
      }
      const found = findProjectConfig()
      if (!found) return
      const relPath = path.relative(found.root, uri.fsPath).replace(/\\/g, "/")
      const row = stateDb.getFileByPath(relPath)
      if (!row) {
        vscode.window.showInformationMessage(`Shynkro: "${path.basename(relPath)}" is not tracked.`)
        return
      }

      const confirm = await vscode.window.showWarningMessage(
        `Shynkro: untrack "${path.basename(relPath)}"? This removes the file from the shared workspace for all collaborators. Your local copy will be kept.`,
        { modal: true },
        "Untrack"
      )
      if (confirm !== "Untrack") return

      try {
        // Tell the reconciler to skip the local rm when the server echoes
        // back the fileDeleted broadcast — the user wants to keep their copy.
        changeReconciler?.markUntracked(relPath)
        // E9: Set write tag BEFORE the REST call — the server's fileDeleted
        // broadcast can arrive before the REST response, and the watcher needs
        // the tag to suppress a duplicate delete.
        fileWatcher?.addWriteTag(uri.fsPath)
        await restClient.deleteFile(found.config.workspaceId, row.fileId as import("@shynkro/shared").FileId)
        stateDb.deleteFile(row.fileId)
        vscode.window.showInformationMessage(`Shynkro: "${path.basename(relPath)}" untracked. Local copy kept.`)
        log.appendLine(`[untrack] untracked ${relPath}`)
        syncDecoProviderInstance?.refresh([uri])
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Shynkro: failed to untrack "${path.basename(relPath)}" — ${msg}`)
      }
    }),

    vscode.commands.registerCommand("shynkro.init", async () => {
      const folders = vscode.workspace.workspaceFolders
      if (!folders) { vscode.window.showErrorMessage("Open a folder first"); return }
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)
      await executeInit(folders[0].uri.fsPath, serverUrl, authService!, restClient, (p: string) => new StateDb(p))
      await startSync(serverUrl, restClient, tokenStore, context)
    }),

    vscode.commands.registerCommand("shynkro.clone", async () => {
      const serverUrl = vscode.workspace.getConfiguration("shynkro").get<string>("serverUrl") ?? "http://localhost:3000"
      restClient.setBaseUrl(serverUrl)
      await executeClone(serverUrl, authService!, restClient, (p: string) => new StateDb(p), () =>
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
      await executeClone(serverUrl, authService!, restClient, (p: string) => new StateDb(p), () =>
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
            const db = new StateDb(dbPath)
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
  // M2: Use parseInt to handle pre-release suffixes (e.g. "1.2.3-beta") without NaN
  const parse = (v: string) => v.split(".").map((s) => parseInt(s, 10) || 0)
  const [aMaj, aMin, aPat] = parse(a)
  const [bMaj, bMin, bPat] = parse(b)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPat >= bPat
}

/** E2: Guard against concurrent startSync calls */
let startSyncRunning = false

async function startSync(
  serverUrl: string,
  restClient: RestClient,
  _tokenStore: TokenStore,
  context: vscode.ExtensionContext
): Promise<void> {
  if (startSyncRunning) {
    log.appendLine("[sync] startSync already in progress — skipping")
    return
  }
  startSyncRunning = true
  try {
    await _startSyncInner(serverUrl, restClient, _tokenStore, context)
  } finally {
    startSyncRunning = false
  }
}

async function _startSyncInner(
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
  stateDb = new StateDb(dbPath)
  // Prune stale tombstones so long-running workspaces don't grow the SQLite
  // file unbounded over months. Default is 30 days; tombstones are normally
  // cleared by purgeFile as soon as the server confirms a delete, so this
  // only catches the edge case where that confirmation never arrived.
  const prunedTombstones = stateDb.pruneTombstones()
  if (prunedTombstones > 0) {
    log.appendLine(`[sync] pruned ${prunedTombstones} stale tombstone row(s) from file_map`)
  }
  // Pass stateDb so pending Yjs frames persist across extension reloads (B2).
  wsManager = new WsManager(authService!, statusBar!, stateDb)
  fileWatcher = new FileWatcher(workspaceRoot, config.workspaceId, stateDb, restClient, wsManager)
  // D1: chunked + resumable binary transport. The uploader/downloader use the
  // raw fetch API + Range headers, not the REST client wrapper, because they
  // need to stream chunks rather than buffer the whole file.
  const chunkedUploader = new ChunkedUploader({
    baseUrl: serverUrl,
    getToken: () => authService!.getValidAccessToken(serverUrl).catch(() => undefined),
  })
  const chunkedDownloader = new ChunkedDownloader({
    baseUrl: serverUrl,
    getToken: () => authService!.getValidAccessToken(serverUrl).catch(() => undefined),
  })
  binarySyncInstance = new BinarySync(restClient, stateDb, workspaceRoot, fileWatcher, {
    uploader: chunkedUploader,
    downloader: chunkedDownloader,
  })
  const binarySync = binarySyncInstance
  changeReconciler = new ChangeReconciler(
    config.workspaceId, workspaceRoot, stateDb, restClient, fileWatcher,
    binarySync!
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
  yjsBridge = new YjsBridge(wsManager, fileWatcher, conflictManager, stateDb, workspaceRoot, restClient)

  // Register conflict view now that conflictManager is available
  conflictView?.dispose()
  conflictView = new ConflictView(conflictManager)
  // File decorations: "S" badge on synced files, "!" on conflicts.
  // Dispose any prior registration so a reconnect doesn't stack duplicate badges.
  syncDecoRegistration?.dispose()
  syncDecoProviderInstance?.dispose()
  const syncDecoProvider = new SyncDecorationProvider(workspaceRoot, stateDb, conflictManager)
  syncDecoProviderInstance = syncDecoProvider
  syncDecoRegistration = vscode.window.registerFileDecorationProvider(syncDecoProvider)
  // Do NOT push syncDecoRegistration / syncDecoProvider here — they are
  // re-created on every _startSyncInner and the module-level vars are disposed
  // explicitly (above + in stopSync). Pushing them into context.subscriptions
  // would cause a stale disposable to be re-disposed at deactivate time, which
  // can tear down the *current* provider and drop explorer badges mid-session.
  context.subscriptions.push(
    conflictDecorations,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, conflictLensProvider),
    vscode.window.registerTreeDataProvider("shynkro.conflictView", conflictView),
    // M8: Refresh file badges when conflicts change — use targeted URIs from
    // the conflict list to avoid full-tree invalidation.
    conflictManager.onListChanged(() => {
      const cm = conflictManager
      if (!cm) return
      const uris = cm.getConflicts().map((c) => vscode.Uri.file(c.filePath))
      syncDecoProvider.refresh(uris.length > 0 ? uris : undefined)
    })
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
      syncDecoProvider.refresh([vscode.Uri.file(absPath)])
    }),
    changeReconciler.onRemoteFileDeleted(({ absPath }) => {
      yjsBridge?.handleFileDeleted(absPath, { remote: true }).catch((err) =>
        log.appendLine(`[sync] handleFileDeleted (remote) error: ${err}`)
      )
      syncDecoProvider.refresh([vscode.Uri.file(absPath)])
    })
  )

  // Refresh sync decorations when new files become tracked (local create,
  // remote create via reconciler, text file registration for Yjs).
  context.subscriptions.push(
    fileWatcher.onTextFileRegistered((fsPath) => {
      syncDecoProvider.refresh([vscode.Uri.file(fsPath)])
    }),
    fileWatcher.onBinaryChanged(({ localPath }) => {
      syncDecoProvider.refresh([vscode.Uri.file(localPath)])
    }),
    changeReconciler.onTextFileRegistered((fsPath) => {
      syncDecoProvider.refresh([vscode.Uri.file(fsPath)])
    }),
    // Refresh decorations for ANY file type (binary, folder, text) tracked
    // by the reconciler — covers WS-driven creates that bypass the text-only
    // events above. Also refreshes parent directories so folder badges update.
    changeReconciler.onFileTracked((fsPath) => {
      const uri = vscode.Uri.file(fsPath)
      const parentUri = vscode.Uri.file(path.dirname(fsPath))
      syncDecoProvider.refresh([uri, parentUri])
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
      if (msg.type === "serverShutdown") {
        // The server is starting its graceful drain — we have ~10 s to flush
        // anything pending. Best-effort drain of the op queue, then dump
        // anything still queued to the recovery JSON so the user doesn't
        // lose work to the imminent forced disconnect. The WS will close on
        // its own once the drain window expires.
        log.appendLine("[sync] received serverShutdown — flushing pending ops")
        if (stateDb) {
          drainPendingOps(stateDb, restClient, config.workspaceId, workspaceRoot)
            .catch((err) => log.appendLine(`[sync] serverShutdown drain error: ${err}`))
            .finally(() => {
              if (!stateDb) return
              const recoveryPath = serializePendingOpsToRecovery(stateDb, workspaceRoot)
              if (recoveryPath) {
                vscode.window.showWarningMessage(
                  `Shynkro: server is shutting down. Unsynced changes were saved to ${path.basename(recoveryPath)}.`
                )
              } else {
                vscode.window.showInformationMessage(
                  "Shynkro: server is shutting down. Sync will resume on reconnect."
                )
              }
              // Close our end cleanly so the server drain sees the count drop
              // immediately instead of waiting for the force-close timeout.
              // closeForReconnect() lets the close handler run so the reconnect
              // loop stays active and picks the server back up when it restarts.
              wsManager?.closeForReconnect()
            })
        }
        return
      }
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
        log.appendLine(`[sync] presenceUpdate: ${msg.users.length} user(s) — ${msg.users.map((u: { username: string }) => u.username).join(", ")}`)
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
            changeReconciler?.reconcile()
              .then(() => syncDecoProviderInstance?.refresh())
              .catch((err) => {
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
  // M5: reset the start guard so a logout-then-login (or any stop→start race)
  // doesn't leave `startSyncRunning` pinned at true, silently dropping the
  // next connect attempt.
  startSyncRunning = false
  syncDecoRegistration?.dispose()
  syncDecoRegistration = null
  syncDecoProviderInstance?.dispose()
  syncDecoProviderInstance = null
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
