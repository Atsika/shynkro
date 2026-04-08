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
    const body = await request.arrayBuffer()
    const data = new Uint8Array(body)

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

    // Clean up old blob (best-effort, after successful DB update)
    if (oldHash && oldHash !== hash) {
      storage.delete(oldHash).catch((err) =>
        logger.error("old blob cleanup failed", { hash: oldHash, err: String(err) })
      )
    }

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
  .get("/blob", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member) return status(403, { message: "Forbidden" })

    const [file] = await db
      .select()
      .from(fileEntries)
      .where(and(eq(fileEntries.id, params.fileId), eq(fileEntries.deleted, false)))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })
    if (!file.binaryHash) return status(404, { message: "No blob uploaded yet" })

    const data = await storage.get(file.binaryHash)
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Content-Hash": file.binaryHash,
      "Content-Length": String(data.byteLength),
    }
    if (file.mode !== null && file.mode !== undefined) {
      headers["X-File-Mode"] = String(file.mode & 0o777)
    }
    return new Response(data.buffer as ArrayBuffer, { headers })
  })
