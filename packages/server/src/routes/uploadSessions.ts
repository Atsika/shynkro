/**
 * Chunked + resumable binary upload (D1).
 *
 * Pentest workspaces routinely contain 1 GB+ binaries (zipped scans, pcap
 * dumps, raw memory captures). The original `PUT /blob` endpoint loads the
 * entire payload into memory at the server, which is unworkable above ~200 MB
 * and OOMs the extension on the client side. This module replaces it with a
 * multipart session protocol that streams chunks to disk and assembles them
 * on completion, never holding more than one chunk in memory at a time.
 *
 * Wire shape:
 *
 *   POST   /api/v1/workspaces/:id/files/:fileId/upload-session     → start
 *   PUT    /api/v1/workspaces/:id/upload-session/:sessionId/chunk/:index
 *   GET    /api/v1/workspaces/:id/upload-session/:sessionId/status
 *   POST   /api/v1/workspaces/:id/upload-session/:sessionId/complete
 *   DELETE /api/v1/workspaces/:id/upload-session/:sessionId
 *
 * Sessions live in the `upload_sessions` Postgres table; chunks live on disk
 * under `<SHYNKRO_BLOB_DIR>/.upload-sessions/<sessionId>/<index>.bin`. The
 * `expireUploadSessions` job sweeps abandoned sessions on a 5-minute interval.
 */

import Elysia, { t, status } from "elysia"
import { and, eq, sql } from "drizzle-orm"
import * as nodeFs from "node:fs"
import { db } from "../db/index.js"
import { fileEntries, uploadSessions } from "../db/schema.js"
import { activeFileById } from "../db/predicates.js"
import { withAuth } from "../middleware/auth.js"
import { uuid } from "../utils.js"
import { requireMember } from "../lib/authz.js"
import { recordChange } from "../lib/changeLog.js"
import { broadcastToWorkspace } from "../services/realtimeState.js"
import { logger } from "../lib/logger.js"
import { FilesystemStorageBackend } from "../storage/FilesystemStorageBackend.js"
import { createStorageBackend } from "../storage/index.js"

const storage = createStorageBackend()

// We need the chunked methods, which only exist on FilesystemStorageBackend.
// If a future backend implements them via a different concrete class, this
// cast will need to grow into a capability check.
const chunkedStorage = storage as unknown as FilesystemStorageBackend

const SESSION_TTL_MINUTES = 60

/** Default per-chunk size offered to clients that don't specify one. 8 MB strikes a
 * good balance: large enough that the per-chunk overhead is small, small enough
 * that a re-upload of a single failed chunk is cheap. */
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

const MAX_BLOB_BYTES = (() => {
  const raw = process.env.SHYNKRO_MAX_BLOB_SIZE
  if (!raw) return 50 * 1024 * 1024 * 1024
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50 * 1024 * 1024 * 1024
  return parsed
})()

/**
 * D3: pre-flight disk-space check. Verifies the storage backend has at least
 * `totalSize * 1.5` free bytes before accepting a session — leaves headroom
 * for chunks + the assembled blob coexisting briefly during the rename.
 *
 * Uses `fs.statfsSync` (Node 22+, supported by Bun). If the call fails for any
 * reason (unsupported platform, missing permissions), the check is skipped and
 * we let the upload proceed — the blob size cap (D2) and the storage backend's
 * own ENOSPC errors still provide a backstop.
 */
function hasEnoughDiskSpace(blobDir: string, requiredBytes: number): boolean {
  try {
    const statfsFn = (nodeFs as { statfsSync?: (p: string) => { bsize: number; bavail: number } }).statfsSync
    if (typeof statfsFn !== "function") return true
    const stats = statfsFn(blobDir)
    const free = stats.bsize * stats.bavail
    return free >= Math.ceil(requiredBytes * 1.5)
  } catch {
    return true // best-effort — fall through and let the upload race the OS
  }
}

const BLOB_DIR = process.env.SHYNKRO_BLOB_DIR ?? "./blobs"

export const uploadSessionRoutes = new Elysia({ prefix: "/api/v1/workspaces/:id" })
  .use(withAuth)

  // POST /files/:fileId/upload-session
  .post(
    "/files/:fileId/upload-session",
    async ({ params, body, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      const [file] = await db
        .select()
        .from(fileEntries)
        .where(activeFileById(params.fileId))
        .limit(1)
      if (!file) return status(404, { message: "File not found" })
      if (file.kind !== "binary") return status(400, { message: "Not a binary file" })

      const { totalSize, sha256, chunkSize: clientChunk, fileName } = body
      if (!Number.isInteger(totalSize) || totalSize < 0) {
        return status(400, { message: "totalSize must be a non-negative integer" })
      }
      if (totalSize > MAX_BLOB_BYTES) {
        return status(413, {
          code: "BLOB_TOO_LARGE",
          message: `Declared totalSize ${totalSize} bytes exceeds SHYNKRO_MAX_BLOB_SIZE=${MAX_BLOB_BYTES}.`,
        })
      }
      if (!/^[0-9a-f]{64}$/.test(sha256)) {
        return status(400, { message: "sha256 must be a 64-char hex string" })
      }

      const chunkSize = clientChunk && clientChunk > 0 && clientChunk <= 64 * 1024 * 1024
        ? clientChunk
        : DEFAULT_CHUNK_SIZE
      const totalChunks = totalSize === 0 ? 0 : Math.ceil(totalSize / chunkSize)

      // D3 disk-space pre-flight.
      if (!hasEnoughDiskSpace(BLOB_DIR, totalSize)) {
        return status(507, {
          code: "INSUFFICIENT_STORAGE",
          message: `Server has insufficient free disk space for an upload of ${totalSize} bytes.`,
        })
      }

      const sessionId = uuid()
      const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60 * 1000)
      await db.insert(uploadSessions).values({
        id: sessionId,
        workspaceId: params.id,
        fileId: params.fileId,
        userId: user.id,
        totalSize,
        chunkSize,
        totalChunks,
        expectedSha256: sha256,
        fileName: fileName ?? null,
        expiresAt,
      })

      return { sessionId, chunkSize, totalChunks, expiresAt: expiresAt.toISOString() }
    },
    {
      body: t.Object({
        totalSize: t.Number(),
        sha256: t.String(),
        chunkSize: t.Optional(t.Number()),
        fileName: t.Optional(t.String()),
      }),
    }
  )

  // PUT /upload-session/:sessionId/chunk/:index
  .put("/upload-session/:sessionId/chunk/:index", async ({ params, request, user }) => {
    const session = await loadActiveSession(params.id, params.sessionId, user.id)
    if (!("id" in session)) return session // status() short-circuit

    const index = Number.parseInt(params.index, 10)
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      return status(400, { message: `Chunk index ${params.index} out of range [0, ${session.totalChunks})` })
    }

    // Cap each chunk at the declared chunkSize plus a small slack so a slightly-
    // oversized last-chunk request doesn't fail. The complete step's size sum
    // is the source of truth.
    const contentLength = request.headers.get("content-length")
    if (contentLength !== null) {
      const declared = Number.parseInt(contentLength, 10)
      if (Number.isFinite(declared) && declared > session.chunkSize * 1.1) {
        return status(413, {
          code: "CHUNK_TOO_LARGE",
          message: `Chunk size ${declared} exceeds session chunkSize ${session.chunkSize}.`,
        })
      }
    }

    const data = new Uint8Array(await request.arrayBuffer())
    try {
      await chunkedStorage.writeChunk(params.sessionId, index, data)
    } catch (err) {
      logger.error("writeChunk failed", { sessionId: params.sessionId, index, err: String(err) })
      return status(500, { message: "Failed to persist chunk" })
    }

    return { accepted: true, index, size: data.byteLength }
  })

  // GET /upload-session/:sessionId/status
  .get("/upload-session/:sessionId/status", async ({ params, user }) => {
    const session = await loadActiveSession(params.id, params.sessionId, user.id)
    if (!("id" in session)) return session

    const received = await chunkedStorage.listChunkIndices(params.sessionId)
    return {
      sessionId: params.sessionId,
      totalChunks: session.totalChunks,
      receivedChunks: received,
      complete: received.length === session.totalChunks,
    }
  })

  // POST /upload-session/:sessionId/complete
  .post("/upload-session/:sessionId/complete", async ({ params, user }) => {
    const session = await loadActiveSession(params.id, params.sessionId, user.id)
    if (!("id" in session)) return session

    const received = await chunkedStorage.listChunkIndices(params.sessionId)
    if (received.length !== session.totalChunks) {
      return status(400, {
        code: "INCOMPLETE_SESSION",
        message: `Expected ${session.totalChunks} chunks, have ${received.length}. Use GET /status to find missing.`,
      })
    }

    let assembled: { hash: string; size: number }
    try {
      assembled = await chunkedStorage.assembleSession(params.sessionId, session.totalChunks)
    } catch (err) {
      logger.error("assembleSession failed", { sessionId: params.sessionId, err: String(err) })
      return status(500, { message: "Failed to assemble blob" })
    }

    if (assembled.hash !== session.expectedSha256) {
      // Drop the assembled blob — it does not match what the client said it
      // would. The chunks are already gone (assembleSession moved them).
      try {
        await storage.delete(assembled.hash)
      } catch { /* best-effort */ }
      return status(400, {
        code: "HASH_MISMATCH",
        message: `Assembled SHA-256 ${assembled.hash} != declared ${session.expectedSha256}.`,
      })
    }
    if (assembled.size !== session.totalSize) {
      try { await storage.delete(assembled.hash) } catch { /* best-effort */ }
      return status(400, {
        code: "SIZE_MISMATCH",
        message: `Assembled size ${assembled.size} != declared ${session.totalSize}.`,
      })
    }

    // Persist the file_entries update + clean up the session row in one
    // transaction so a crash mid-way leaves no half-state.
    let revision!: number
    await db.transaction(async (tx) => {
      await tx
        .update(fileEntries)
        .set({ binaryHash: assembled.hash, binarySize: assembled.size, updatedAt: new Date() })
        .where(eq(fileEntries.id, session.fileId))
      const result = await tx.execute<{ revision: number }>(
        sql`UPDATE workspaces SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.id} RETURNING revision`
      )
      revision = result[0]!.revision
      await tx.delete(uploadSessions).where(eq(uploadSessions.id, params.sessionId))
    })

    // Clean up chunks now that the assembled blob is in place. Best-effort —
    // expireUploadSessions will eventually catch anything we miss.
    await chunkedStorage.cleanupSession(params.sessionId)

    broadcastToWorkspace(params.id, {
      type: "binaryUpdated",
      workspaceId: params.id,
      fileId: session.fileId,
      hash: assembled.hash,
      size: assembled.size,
      revision,
    })

    await recordChange({
      workspaceId: params.id,
      revision,
      type: "binaryUpdated",
      fileId: session.fileId,
      hash: assembled.hash,
      size: assembled.size,
    })

    return { hash: assembled.hash, size: assembled.size }
  })

  // DELETE /upload-session/:sessionId — abort and cleanup
  .delete("/upload-session/:sessionId", async ({ params, user }) => {
    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.id, params.sessionId), eq(uploadSessions.userId, user.id)))
      .limit(1)
    if (!session) return status(404, { message: "Session not found" })

    await db.delete(uploadSessions).where(eq(uploadSessions.id, params.sessionId))
    await chunkedStorage.cleanupSession(params.sessionId)
    return { ok: true }
  })

/**
 * Look up a session and verify it belongs to the workspace + user, hasn't
 * expired, and exists. Returns either the session row or a status() response
 * the caller should return as-is.
 */
async function loadActiveSession(workspaceId: string, sessionId: string, userId: string) {
  const [row] = await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, sessionId),
        eq(uploadSessions.workspaceId, workspaceId),
        eq(uploadSessions.userId, userId)
      )
    )
    .limit(1)
  if (!row) return status(404, { message: "Upload session not found" })
  if (new Date() > row.expiresAt) {
    return status(410, { code: "SESSION_EXPIRED", message: "Upload session expired" })
  }
  return row
}
