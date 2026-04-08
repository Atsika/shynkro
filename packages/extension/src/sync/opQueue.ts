import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { WorkspaceId, FileId, FileKind } from "@shynkro/shared"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import { log } from "../logger"
import { decodeTextFile } from "../text/textNormalize"

const IS_WINDOWS = os.platform() === "win32"

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
        // For text files, normalize the on-disk content to canonical LF / no-BOM
        // form so the Y.Doc that the server creates from this never holds CRLF.
        // The format we sniff here is also persisted so write-backs are faithful.
        let content: string | undefined
        let decoded: ReturnType<typeof decodeTextFile> | null = null
        if (kind === "text") {
          if (op.content === null) {
            try {
              decoded = decodeTextFile(fs.readFileSync(absPath, "utf-8"))
              content = decoded.content
            } catch (err) {
              log.appendLine(`[opQueue] read error for ${op.path}: ${err}`)
              continue
            }
          } else {
            decoded = decodeTextFile(op.content)
            content = decoded.content
          }
        }
        // POSIX mode bits — recorded on POSIX hosts so the recipient can chmod.
        let mode: number | undefined
        if (!IS_WINDOWS) {
          try {
            mode = fs.statSync(absPath).mode & 0o777
          } catch {
            // best-effort; mode preservation is not critical for the create itself
          }
        }
        const file = await restClient.createFile(workspaceId, { path: op.path, kind, content, mode })
        stateDb.upsertFile(file.id, op.path, kind, file.docId ?? undefined)
        if (decoded) stateDb.setTextFormat(file.id, decoded.eol, decoded.bom)
        if (mode !== undefined) stateDb.setFileMode(file.id, mode)
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

      } else if (op.opType === "rename") {
        // Rename op: `path` is the new path, `content` carries the old path so the
        // server knows which file to update. fileId points at the renamed file.
        if (!op.fileId) {
          log.appendLine(`[opQueue] skipping rename with no fileId: ${op.path}`)
          stateDb.removePendingOp(op.id)
          continue
        }
        try {
          await restClient.renameFile(workspaceId, op.fileId as FileId, { path: op.path })
          stateDb.renameFile(op.fileId, op.path)
          log.appendLine(`[opQueue] replayed rename ${op.content ?? "?"} → ${op.path}`)
        } catch (err) {
          log.appendLine(`[opQueue] rename replay error for ${op.path}: ${err}`)
          throw err // leave in queue
        }
      }

      stateDb.removePendingOp(op.id)
    } catch (err) {
      // Leave the op in the queue — it will retry on the next reconnect
      log.appendLine(`[opQueue] error replaying op ${op.id} (${op.opType} ${op.path}): ${err}`)
    }
  }

  return created
}
