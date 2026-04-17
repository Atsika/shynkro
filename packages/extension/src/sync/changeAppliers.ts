import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { log } from "../logger"
import { safeJoin } from "../pathUtils"
import type {
  FileId,
  WorkspaceId,
  FileCreatedMessage,
  FileRenamedMessage,
  FileDeletedMessage,
  BinaryUpdatedMessage,
} from "@shynkro/shared"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { FileWatcher } from "./fileWatcher"
import type { BinarySync } from "../binary/binarySync"
import { encodeTextForDisk, defaultEol } from "../text/textNormalize"
import { atomicWriteFileSync } from "../text/atomicWrite"

/**
 * Collaborator interface the appliers need from the reconciler. Split out so
 * the 4 apply functions can live in their own file without the full reconciler
 * class dragging them in.
 */
export interface ApplierContext {
  readonly workspaceId: WorkspaceId
  readonly workspaceRoot: string
  readonly stateDb: StateDb
  readonly restClient: RestClient
  readonly fileWatcher: FileWatcher
  readonly binarySync: BinarySync
  readonly untrackedPaths: Set<string>
  readonly locallyInitiatedDeletes: Set<string>
  setRevisionIfLive(msg: { revision: number }): void
  emitTextFileRegistered(localPath: string): void
  emitFileTracked(localPath: string): void
  emitRemoteFileDeleted(args: { absPath: string }): void
  emitBinaryReconciled(args: { fileId: string; serverHash: string; revision: number }): void
  emitBinaryConflict(args: {
    fileId: string
    workspaceId: WorkspaceId
    localPath: string
    localHash: string
    serverHash: string
    revision: number
  }): void
}

export async function applyCreated(ctx: ApplierContext, msg: FileCreatedMessage): Promise<void> {
  const localPath = safeJoin(ctx.workspaceRoot, msg.path)
  if (!localPath) { log.appendLine(`[reconciler] path traversal blocked: ${msg.path}`); return }

  // If this path was intentionally deleted by the local user, re-delete it from the
  // server instead of restoring it. This handles server restarts that replay file
  // history and re-surface files the user already deleted.
  if (ctx.stateDb.isPathDeleted(msg.path)) {
    log.appendLine(`[reconciler] re-deleting tombstoned path from server: ${msg.path}`)
    ctx.restClient.deleteFile(ctx.workspaceId, msg.fileId as FileId).catch((err) => {
      log.appendLine(`[reconciler] re-delete error for ${msg.path}: ${err}`)
    })
    ctx.setRevisionIfLive(msg)
    return
  }

  // Skip files that already exist on disk — Yjs handles content sync for text files
  if (fs.existsSync(localPath)) {
    ctx.stateDb.upsertFile(msg.fileId, msg.path, msg.kind, msg.docId ?? undefined)
    ctx.setRevisionIfLive(msg)
    if (msg.kind === "text" && msg.docId) ctx.emitTextFileRegistered(localPath)
    ctx.emitFileTracked(localPath)
    return
  }

  const dir = path.dirname(localPath)
  fs.mkdirSync(dir, { recursive: true })

  if (msg.kind === "text") {
    try {
      // Server holds canonical LF / no-BOM text. Reconstruct disk format from
      // the per-file metadata recorded by whichever client first ingested it
      // (or fall back to the OS default for files seeded from outside this client).
      const content = await ctx.restClient.getFileContent(ctx.workspaceId, msg.fileId)
      ctx.stateDb.upsertFile(msg.fileId, msg.path, msg.kind, msg.docId ?? undefined)
      // Mode bits broadcast over the WS message — capture before write so chmod
      // below sees them. For text files, mode flows only through the create event.
      if (msg.mode !== null && msg.mode !== undefined) {
        ctx.stateDb.setFileMode(msg.fileId, msg.mode & 0o777)
      }
      const row = ctx.stateDb.getFileById(msg.fileId)
      const eol = (row?.eolStyle ?? defaultEol()) as "lf" | "crlf"
      const bom = !!row?.hasBom
      const encoded = encodeTextForDisk(content, eol, bom)
      ctx.fileWatcher.addWriteTag(localPath)
      atomicWriteFileSync(localPath, encoded, { encoding: "utf-8" })
      // Persist the format we just used so subsequent reads stay consistent.
      if (row && row.eolStyle === null) {
        ctx.stateDb.setTextFormat(msg.fileId, eol, bom)
      }
      // Apply mode bits to the freshly-written file (POSIX hosts only).
      if (process.platform !== "win32" && row?.mode !== null && row?.mode !== undefined) {
        try {
          fs.chmodSync(localPath, row.mode)
        } catch (err) {
          log.appendLine(`[reconciler] chmod ${row.mode.toString(8)} failed for ${localPath}: ${err}`)
        }
      }
      ctx.setRevisionIfLive(msg)
      log.appendLine(`[reconciler] created ${msg.path}`)
      ctx.emitTextFileRegistered(localPath)
      ctx.emitFileTracked(localPath)
    } catch (err) {
      log.appendLine(`[reconciler] applyCreated error for ${msg.path}: ${err}`)
    }
  } else if (msg.kind === "binary") {
    // Register in stateDb first so binaryUpdated can find it even if download fails
    ctx.stateDb.upsertFile(msg.fileId, msg.path, msg.kind)
    if (msg.mode !== null && msg.mode !== undefined) {
      ctx.stateDb.setFileMode(msg.fileId, msg.mode & 0o777)
    }
    ctx.setRevisionIfLive(msg)
    ctx.emitFileTracked(localPath)
    // Only attempt download if the event carries a hash — the live WS
    // broadcast path fires fileCreated before the blob upload completes, so
    // the server would return 404 "No blob uploaded yet". The subsequent
    // binaryUpdated event (emitted after blob upload) will trigger the
    // download via applyBinaryUpdated. For /changes catch-up the hash is
    // already present and we download immediately.
    if (msg.hash) {
      try {
        await ctx.binarySync.download(msg.fileId, localPath, ctx.workspaceId)
      } catch (err) {
        log.appendLine(`[reconciler] binarySync.download error for ${msg.path}: ${err}`)
      }
    } else {
      log.appendLine(`[reconciler] binary ${msg.path} created without hash yet; waiting for binaryUpdated`)
    }
  } else {
    // folder
    fs.mkdirSync(localPath, { recursive: true })
    ctx.stateDb.upsertFile(msg.fileId, msg.path, msg.kind)
    ctx.setRevisionIfLive(msg)
    ctx.emitFileTracked(localPath)
  }
}

export async function applyRenamed(ctx: ApplierContext, msg: FileRenamedMessage): Promise<void> {
  const oldLocal = safeJoin(ctx.workspaceRoot, msg.oldPath)
  const newLocal = safeJoin(ctx.workspaceRoot, msg.path)
  if (!oldLocal || !newLocal) { log.appendLine(`[reconciler] path traversal blocked: rename ${msg.oldPath} -> ${msg.path}`); return }
  try {
    fs.mkdirSync(path.dirname(newLocal), { recursive: true })
    // Only rename on disk if we still have the source and don't already have the
    // target — otherwise this is the echo of our own local rename, where the
    // filesystem move was performed by VS Code before this WS message arrived.
    const oldExists = fs.existsSync(oldLocal)
    const newExists = fs.existsSync(newLocal)
    if (oldExists && !newExists) {
      ctx.fileWatcher.addWriteTag(newLocal)
      ctx.fileWatcher.addWriteTag(oldLocal)
      fs.renameSync(oldLocal, newLocal)
    }
    // stateDb.renameFile is idempotent — safe to call whether or not we just moved.
    ctx.stateDb.renameFile(msg.fileId, msg.path)
    ctx.setRevisionIfLive(msg)
    ctx.emitFileTracked(newLocal)
    ctx.emitFileTracked(oldLocal)
  } catch (err) {
    log.appendLine(`[reconciler] applyRenamed error: ${err}`)
  }
}

export async function applyDeleted(ctx: ApplierContext, msg: FileDeletedMessage): Promise<void> {
  const localPath = safeJoin(ctx.workspaceRoot, msg.path)
  if (!localPath) { log.appendLine(`[reconciler] path traversal blocked: ${msg.path}`); return }

  // Skip the local rm if:
  //  (a) the user explicitly untracked this path — they want the disk copy
  //      preserved, OR
  //  (b) this is the echo of a delete we initiated locally — the user may
  //      have created a replacement file with the same path already, and
  //      blindly rmSync'ing would wipe it.
  const isUntrack = ctx.untrackedPaths.has(msg.path)
  if (isUntrack) ctx.untrackedPaths.delete(msg.path)
  const wasLocal = ctx.locallyInitiatedDeletes.has(msg.fileId)
  if (wasLocal) ctx.locallyInitiatedDeletes.delete(msg.fileId)
  const skipRm = isUntrack || wasLocal

  ctx.fileWatcher.addWriteTag(localPath)
  // Signal the Yjs bridge so any open editor for this file gets torn down
  // (closes the tab, prompts for recovery if dirty, unsubscribes the doc).
  // Fire before removing the file so the bridge's lookup by path still works.
  ctx.emitRemoteFileDeleted({ absPath: localPath })

  if (!skipRm) {
    try {
      // rmSync handles files, directories (recursive), and is a no-op when force:true + path missing
      fs.rmSync(localPath, { recursive: true, force: true })
    } catch (err) {
      log.appendLine(`[reconciler] applyDeleted error for ${msg.path}: ${err}`)
    }
  } else if (wasLocal) {
    log.appendLine(`[reconciler] applyDeleted: skipping rm for locally-initiated delete ${msg.path}`)
  }

  // Hard-delete: server has confirmed the deletion, so the tombstone is no longer needed.
  ctx.stateDb.purgeFile(msg.fileId)
  ctx.setRevisionIfLive(msg)
  void vscode
}

export async function applyBinaryUpdated(ctx: ApplierContext, msg: BinaryUpdatedMessage): Promise<void> {
  const row = ctx.stateDb.getFileById(msg.fileId)
  if (!row) return
  // Refresh stored mode bits regardless of whether content changed.
  if (msg.mode !== null && msg.mode !== undefined) {
    ctx.stateDb.setFileMode(msg.fileId, msg.mode & 0o777)
  }
  if (row.binaryHash === msg.hash) {
    // Already matched — make sure the synced marker is up to date too, then
    // notify so an open picker can auto-dismiss.
    if (row.syncedBinaryHash !== msg.hash) {
      ctx.stateDb.setSyncedBinaryHash(msg.fileId, msg.hash)
    }
    ctx.emitBinaryReconciled({ fileId: msg.fileId, serverHash: msg.hash, revision: msg.revision })
    return
  }

  const localPath = safeJoin(ctx.workspaceRoot, row.path)
  if (!localPath) { log.appendLine(`[reconciler] path traversal blocked: ${row.path}`); return }
  try {
    const syncedHash = row.syncedBinaryHash ?? row.binaryHash
    let localHash: string | undefined
    if (fs.existsSync(localPath)) {
      localHash = await ctx.binarySync.computeHash(localPath)
    }
    const localChanged = !!syncedHash && !!localHash && localHash !== syncedHash

    // Coincidentally identical: local edit happens to match server's new hash.
    if (localHash === msg.hash) {
      ctx.stateDb.setSyncedBinaryHash(msg.fileId, msg.hash)
      ctx.emitBinaryReconciled({ fileId: msg.fileId, serverHash: msg.hash, revision: msg.revision })
      ctx.setRevisionIfLive(msg)
      return
    }

    if (localChanged && localHash) {
      // True conflict — defer to the picker (wired externally at startup).
      // Don't download/upload here; the picker will choose and call binarySync.
      ctx.emitBinaryConflict({
        fileId: msg.fileId,
        workspaceId: ctx.workspaceId,
        localPath,
        localHash,
        serverHash: msg.hash,
        revision: msg.revision,
      })
      // Fire reconciled so any *other* open picker for this file refreshes,
      // but don't mark synced — the user still owes a decision.
      ctx.emitBinaryReconciled({ fileId: msg.fileId, serverHash: msg.hash, revision: msg.revision })
      ctx.setRevisionIfLive(msg)
      return
    }

    // No local change → silent download.
    await ctx.binarySync.download(msg.fileId as FileId, localPath, ctx.workspaceId)
    // binarySync.download already sets syncedBinaryHash.
    ctx.emitBinaryReconciled({ fileId: msg.fileId, serverHash: msg.hash, revision: msg.revision })
    ctx.setRevisionIfLive(msg)
  } catch (err) {
    log.appendLine(`[reconciler] applyBinaryUpdated error for ${row.path}: ${err}`)
  }
}
