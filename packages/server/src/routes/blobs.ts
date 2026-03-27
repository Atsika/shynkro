import Elysia, { status } from "elysia"
import { eq, and, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { fileEntries } from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { createStorageBackend } from "../storage/index.js"
import { broadcastToWorkspace } from "../services/realtimeState.js"
import { requireMember } from "../lib/authz.js"
import { recordChange } from "../lib/changeLog.js"

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
    const body = await request.arrayBuffer()
    const data = new Uint8Array(body)

    // Compute SHA-256 hash
    const hashBuffer = await crypto.subtle.digest("SHA-256", body)
    const hash = Buffer.from(hashBuffer).toString("hex")

    if (clientHash && clientHash !== hash) {
      return status(400, { message: "Content hash mismatch" })
    }

    await storage.put(hash, data)

    await db
      .update(fileEntries)
      .set({ binaryHash: hash, binarySize: data.byteLength, updatedAt: new Date() })
      .where(eq(fileEntries.id, params.fileId))

    const result = await db.execute<{ revision: number }>(
      sql`UPDATE workspaces SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.id} RETURNING revision`
    )
    const revision = result[0]!.revision

    broadcastToWorkspace(params.id, {
      type: "binaryUpdated",
      workspaceId: params.id,
      fileId: params.fileId,
      hash,
      size: data.byteLength,
      revision,
    })

    await recordChange({ workspaceId: params.id, revision, type: "binaryUpdated", fileId: params.fileId, hash, size: data.byteLength })

    return { hash, size: data.byteLength }
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
    return new Response(data.buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Content-Hash": file.binaryHash,
        "Content-Length": String(data.byteLength),
      },
    })
  })
