import * as fs from "fs"
import * as path from "path"
import type { WorkspaceId, FileId, FileKind } from "@shynkro/shared"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import { log } from "../logger"

export interface DrainedFile {
  fileId: FileId
  path: string
  kind: string
  docId?: string
}

/**
 * Replay all queued offline operations against the server in FIFO order.
 * Returns the list of files successfully created (so callers can bridge editors).
 */
export async function drainPendingOps(
  stateDb: StateDb,
  restClient: RestClient,
  workspaceId: WorkspaceId,
  workspaceRoot: string
): Promise<DrainedFile[]> {
  const ops = stateDb.dequeuePendingOps()
  if (ops.length === 0) return []

  log.appendLine(`[opQueue] draining ${ops.length} pending op(s)`)
  const created: DrainedFile[] = []

  for (const op of ops) {
    try {
      if (op.opType === "create") {
        const absPath = path.join(workspaceRoot, op.path)
        // Skip if file no longer exists on disk
        if (!fs.existsSync(absPath)) {
          log.appendLine(`[opQueue] skipping create for missing file: ${op.path}`)
          stateDb.removePendingOp(op.id)
          continue
        }
        // Skip if already known (e.g. server-side create arrived via WS before drain)
        if (stateDb.getFileByPath(op.path)) {
          log.appendLine(`[opQueue] skipping create, already in stateDb: ${op.path}`)
          stateDb.removePendingOp(op.id)
          continue
        }
        const kind = (op.kind ?? "binary") as FileKind
        const content = kind === "text" && op.content === null
          ? fs.readFileSync(absPath, "utf-8")  // re-read in case file changed
          : op.content ?? undefined
        const file = await restClient.createFile(workspaceId, { path: op.path, kind, content })
        stateDb.upsertFile(file.id, op.path, kind, file.docId ?? undefined)
        created.push({ fileId: file.id as FileId, path: op.path, kind, docId: file.docId ?? undefined })
        log.appendLine(`[opQueue] replayed create ${op.path} → id=${file.id}`)

      } else if (op.opType === "delete") {
        if (!op.fileId) {
          log.appendLine(`[opQueue] skipping delete with no fileId: ${op.path}`)
          stateDb.removePendingOp(op.id)
          continue
        }
        await restClient.deleteFile(workspaceId, op.fileId as FileId)
        log.appendLine(`[opQueue] replayed delete ${op.path}`)
      }

      stateDb.removePendingOp(op.id)
    } catch (err) {
      // Leave the op in the queue — it will retry on the next reconnect
      log.appendLine(`[opQueue] error replaying op ${op.id} (${op.opType} ${op.path}): ${err}`)
    }
  }

  return created
}
