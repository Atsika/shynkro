import Elysia, { status } from "elysia"
import { eq, and, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { fileEntries } from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { createStorageBackend } from "../storage/index.js"
import { broadcastToWorkspace } from "../services/realtimeState.js"
import { requireMember } from "../lib/authz.js"
import { recordChange } from "../lib/changeLog.js"
import { logger } from "../lib/logger.js"

const storage = createStorageBackend()

/**
 * Maximum bytes accepted for a single blob upload, configurable via
 * SHYNKRO_MAX_BLOB_SIZE. Default 50 GB — generous enough for typical pentest
 * artifacts (zipped scans, pcap files, large screenshots) without being
 * unbounded. Disk-bound after that.
 */
const MAX_BLOB_BYTES = (() => {
  const raw = process.env.SHYNKRO_MAX_BLOB_SIZE
  if (!raw) return 50 * 1024 * 1024 * 1024
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn("SHYNKRO_MAX_BLOB_SIZE is not a positive integer, falling back to default", { raw })
    return 50 * 1024 * 1024 * 1024
  }
  return parsed
})()

export const blobRoutes = new Elysia({ prefix: "/api/v1/workspaces/:id/files/:fileId" })
  .use(withAuth)

  // PUT /api/v1/workspaces/:id/files/:fileId/blob
  .put("/blob", async ({ params, request, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

    const [file] = await db
      .select()
      .from(fileEntries)
      .where(and(eq(fileEntries.id, params.fileId), eq(fileEntries.deleted, false)))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })
    if (file.kind !== "binary") return status(400, { message: "Not a binary file" })

    const clientHash = request.headers.get("x-content-hash")
    // Per-upload POSIX mode bits, sent only by clients running on POSIX hosts.
    // Sanitize aggressively: never trust the client past the 9-bit mode mask.
    const modeHeader = request.headers.get("x-file-mode")
    const mode = modeHeader !== null ? Number.parseInt(modeHeader, 10) : NaN
    const sanitizedMode = Number.isFinite(mode) ? mode & 0o777 : null

    // Pre-flight size check via Content-Length so a 100 GB upload doesn't get
    // fully buffered into memory before we reject it. arrayBuffer() below also
    // applies the cap as a defensive second check (Content-Length is advisory).
    const contentLength = request.headers.get("content-length")
    if (contentLength !== null) {
      const declared = Number.parseInt(contentLength, 10)
      if (Number.isFinite(declared) && declared > MAX_BLOB_BYTES) {
        return status(413, {
          code: "BLOB_TOO_LARGE",
          message: `Blob ${declared} bytes exceeds SHYNKRO_MAX_BLOB_SIZE=${MAX_BLOB_BYTES}. Increase the env var on the server to accept larger files.`,
        })
      }
    }

    const body = await request.arrayBuffer()
    const data = new Uint8Array(body)
    if (data.byteLength > MAX_BLOB_BYTES) {
      return status(413, {
        code: "BLOB_TOO_LARGE",
        message: `Blob ${data.byteLength} bytes exceeds SHYNKRO_MAX_BLOB_SIZE=${MAX_BLOB_BYTES}.`,
      })
    }

    // Compute SHA-256 hash
    const hashBuffer = await crypto.subtle.digest("SHA-256", body)
    const hash = Buffer.from(hashBuffer).toString("hex")

    if (clientHash && clientHash !== hash) {
      return status(400, { message: "Content hash mismatch" })
    }

    const oldHash = file.binaryHash

    await storage.put(hash, data)

    let revision!: number
    await db.transaction(async (tx) => {
      await tx
        .update(fileEntries)
        .set({
          binaryHash: hash,
          binarySize: data.byteLength,
          // Only overwrite mode if the uploader sent one — preserves any prior recording
          // when a Windows client (no mode header) re-uploads the same file.
          ...(sanitizedMode !== null ? { mode: sanitizedMode } : {}),
          updatedAt: new Date(),
        })
        .where(eq(fileEntries.id, params.fileId))
      const result = await tx.execute<{ revision: number }>(
        sql`UPDATE workspaces SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.id} RETURNING revision`
      )
      revision = result[0]!.revision
    })

    // Old blob cleanup is delegated to gcBlobs (D8). The previous unconditional
    // best-effort delete here was unsafe in two ways:
    //   1. If the old hash was deduped — i.e. another file shared the same
    //      content — deleting the blob would silently break the other file.
    //   2. The delete could outrun the DB transaction's visibility, leaving a
    //      brief window where the blob was gone but the row still pointed at it.
    // The orphan-GC job handles both cases by checking the actual reference
    // state under the grace period.

    broadcastToWorkspace(params.id, {
      type: "binaryUpdated",
      workspaceId: params.id,
      fileId: params.fileId,
      hash,
      size: data.byteLength,
      mode: sanitizedMode ?? file.mode ?? null,
      revision,
    })

    await recordChange({ workspaceId: params.id, revision, type: "binaryUpdated", fileId: params.fileId, hash, size: data.byteLength })

    return { hash, size: data.byteLength, mode: sanitizedMode ?? file.mode ?? null }
  })

  // GET /api/v1/workspaces/:id/files/:fileId/blob
  //
  // Streams the blob from disk. Supports HTTP `Range: bytes=N-M` so a client
  // can download a 1 GB+ file in chunks (D1 chunked download). A request
  // without a Range header still works for small files but uses streaming on
  // the server side too — never loads the full blob into memory.
  .get("/blob", async ({ params, request, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member) return status(403, { message: "Forbidden" })

    const [file] = await db
      .select()
      .from(fileEntries)
      .where(and(eq(fileEntries.id, params.fileId), eq(fileEntries.deleted, false)))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })
    if (!file.binaryHash) return status(404, { message: "No blob uploaded yet" })

    // We need on-disk size for Content-Length / Content-Range. Bun.file().size
    // is cheap (uses fstat). Falls back to a single get() if the underlying
    // backend isn't filesystem-backed.
    let fullSize: number
    let blobReader: Bun.BunFile | null = null
    try {
      const filesystemStorage = storage as unknown as FilesystemStorageBackendLike
      if (typeof filesystemStorage.blobReadStream === "function") {
        // FilesystemStorageBackend path — measure via Bun.file
        const probe = Bun.file(blobAbsolutePath(file.binaryHash))
        if (!(await probe.exists())) return status(404, { message: "Blob not found in storage" })
        fullSize = probe.size
        blobReader = probe
      } else {
        // Generic path — fall back to one full read.
        const data = await storage.get(file.binaryHash)
        fullSize = data.byteLength
      }
    } catch (err) {
      logger.error("blob read failed", { hash: file.binaryHash, err: String(err) })
      return status(500, { message: "Failed to read blob" })
    }

    const baseHeaders: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Content-Hash": file.binaryHash,
      "Accept-Ranges": "bytes",
    }
    if (file.mode !== null && file.mode !== undefined) {
      baseHeaders["X-File-Mode"] = String(file.mode & 0o777)
    }

    // Parse Range. We support a single byte range — no multi-range responses.
    const rangeHeader = request.headers.get("range")
    if (rangeHeader) {
      const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
      if (!m) return status(416, { message: "Invalid Range header" })
      const startStr = m[1]
      const endStr = m[2]
      let start: number
      let end: number
      if (startStr === "" && endStr !== "") {
        // Suffix range: last N bytes
        const suffix = parseInt(endStr, 10)
        if (!Number.isFinite(suffix) || suffix <= 0) return status(416, { message: "Invalid suffix range" })
        start = Math.max(0, fullSize - suffix)
        end = fullSize - 1
      } else {
        start = parseInt(startStr || "0", 10)
        end = endStr ? parseInt(endStr, 10) : fullSize - 1
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= fullSize || start > end) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${fullSize}` },
        })
      }
      const length = end - start + 1
      const slice = blobReader ? blobReader.slice(start, end + 1) : null
      const body = slice
        ? slice.stream()
        : (await storage.get(file.binaryHash)).slice(start, end + 1)
      return new Response(body as BodyInit, {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Length": String(length),
          "Content-Range": `bytes ${start}-${end}/${fullSize}`,
        },
      })
    }

    // No Range — full body, but still streamed if we can.
    const body = blobReader ? blobReader.stream() : (await storage.get(file.binaryHash))
    return new Response(body as BodyInit, {
      headers: {
        ...baseHeaders,
        "Content-Length": String(fullSize),
      },
    })
  })

// FilesystemStorageBackend exposes blobReadStream + a path-resolution API; the
// rest of the codebase only depends on the StorageBackend interface, so we
// type-narrow at the call site instead of leaking the concrete class through
// imports. Future backends (S3, etc.) would implement Range differently.
interface FilesystemStorageBackendLike {
  blobReadStream?: (hash: string, start?: number, end?: number) => unknown
}

function blobAbsolutePath(hash: string): string {
  // Mirror FilesystemStorageBackend.blobPath without exposing the private
  // method — keeps the route file decoupled from the class internals.
  const root = process.env.SHYNKRO_BLOB_DIR ?? "./blobs"
  return `${root}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`
}
