import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { log } from "../logger"
import { SHYNKRO_DIR, IMPORT_CONCURRENCY } from "../constants"
import { buildIgnoreMatcher } from "../ignoreUtils"
import { ensureShynkroInGitignore } from "./gitUtils"
import { classifyFile, classifyFileWithContent } from "@shynkro/shared"
import { writeProjectConfig } from "./projectConfig"
import { acquireLock } from "../lock/lockFile"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { AuthService } from "../auth/authService"

function collectFiles(dir: string, root: string, ignore: (rel: string) => boolean, result: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).replace(/\\/g, "/")
    if (ignore(rel)) continue
    if (entry.isDirectory()) {
      collectFiles(full, root, ignore, result)
    } else {
      result.push(full)
    }
  }
  return result
}

async function runConcurrent<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

export async function executeInit(
  workspaceRoot: string,
  serverUrl: string,
  authService: AuthService,
  restClient: RestClient,
  makeStateDb: (dbPath: string) => StateDb
): Promise<void> {
  // Ensure logged in and token is valid against the server
  let authed = false
  const token = await authService.getValidAccessToken(serverUrl).catch(() => null)
  if (token) {
    authed = await restClient.me().then(() => true).catch(() => false)
  }
  if (!authed) {
    await authService.logout(serverUrl) // clear any stale tokens
    const ok = await authService.login(serverUrl)
    if (!ok) return
  }

  const folderName = path.basename(workspaceRoot)
  const name = await vscode.window.showInputBox({
    prompt: "Workspace name",
    value: folderName,
  })
  if (!name) return

  // Acquire lock (create dir first so DB and lock can be placed inside)
  const shynkroDir = path.join(workspaceRoot, SHYNKRO_DIR)
  fs.mkdirSync(shynkroDir, { recursive: true })

  // Auto-update .gitignore if this is a git repository
  ensureShynkroInGitignore(workspaceRoot)
  const stateDb = makeStateDb(path.join(shynkroDir, "state.db"))
  if (!acquireLock(shynkroDir)) {
    vscode.window.showErrorMessage("Shynkro: another VS Code window is already syncing this folder")
    return
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Shynkro: initializing workspace…", cancellable: false },
    async (progress) => {
      let ws: Awaited<ReturnType<typeof restClient.createWorkspace>>
      let importId: string
      try {
        ws = await restClient.createWorkspace({ name })
        ;({ importId } = await restClient.beginImport(ws.id))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Shynkro: init failed — ${msg}`)
        return
      }

      const ignore = buildIgnoreMatcher(workspaceRoot)
      const files = collectFiles(workspaceRoot, workspaceRoot, ignore)
      let uploaded = 0
      progress.report({ message: `Found ${files.length} files` })

      try {
        await runConcurrent(files, IMPORT_CONCURRENCY, async (filePath) => {
          const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/")
          const data = fs.readFileSync(filePath)
          const kind = classifyFile(filePath) ?? classifyFileWithContent(filePath, Buffer.from(data))

          let content: string | undefined
          let hash: string | undefined

          if (kind === "text") {
            content = data.toString("utf-8")
          } else {
            const crypto = await import("crypto")
            hash = crypto.createHash("sha256").update(data).digest("hex")
            content = data.toString("base64")
          }

          await restClient.importFile(ws.id, importId, { path: relPath, kind, content, hash })
          uploaded++
          progress.report({ message: `${uploaded}/${files.length} files` })
        })

        await restClient.commitImport(ws.id, importId)
      } catch (err) {
        await restClient.abortImport(ws.id, importId).catch(() => {})
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Shynkro: init failed — ${msg}`)
        return
      }

      try {
        // Fetch current workspace state (revision was bumped by commitImport)
        const currentWs = await restClient.getWorkspace(ws.id)

        // Fetch tree to populate stateDb
        const { files: fileEntries } = await restClient.getTree(ws.id)
        log.appendLine(`[init] getTree returned ${fileEntries.length} files, db=${path.join(workspaceRoot, ".shynkro", "state.db")}`)
        stateDb.clearForRelink()
        for (const f of fileEntries) {
          stateDb.upsertFile(f.id, f.path, f.kind, f.docId ?? undefined, f.binaryHash ?? undefined)
        }
        log.appendLine(`[init] stateDb now has ${stateDb.allFiles().length} files`)
        stateDb.setRevision(ws.id, currentWs.revision)
        stateDb.close()

        writeProjectConfig(workspaceRoot, { workspaceId: ws.id, serverUrl, revision: currentWs.revision })
        vscode.window.showInformationMessage(`Shynkro: workspace "${name}" initialized`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`Shynkro: init failed after upload — ${msg}`)
      }
    }
  )
}
