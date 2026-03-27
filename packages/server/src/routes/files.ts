import Elysia, { t, status } from "elysia"
import { eq, and, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import {
  collaborativeDocs,
  fileEntries,
  workspaces,
  yjsUpdates,
} from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { broadcastToWorkspace } from "../services/realtimeState.js"
import { getPlainText, prepareDocUpdate } from "../services/yjsService.js"
import { uuid, isValidFilePath } from "../utils.js"
import { classifyFile } from "../fileClassifier.js"
import { requireMember } from "../lib/authz.js"
import { recordChange } from "../lib/changeLog.js"

async function incrementRevision(workspaceId: string, tx?: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<number> {
  const executor = tx ?? db
  const result = await executor.execute<{ revision: number }>(
    sql`UPDATE workspaces SET revision = revision + 1, updated_at = NOW() WHERE id = ${workspaceId} RETURNING revision`
  )
  return result[0]!.revision
}

export const fileRoutes = new Elysia({ prefix: "/api/v1/workspaces/:id/files" })
  .use(withAuth)

  // POST /api/v1/workspaces/:id/files
  .post(
    "/",
    async ({ params, body, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      if (!isValidFilePath(body.path)) return status(400, { message: "Invalid file path" })

      const [existing] = await db
        .select({ id: fileEntries.id })
        .from(fileEntries)
        .where(
          and(
            eq(fileEntries.workspaceId, params.id),
            eq(fileEntries.path, body.path),
            eq(fileEntries.deleted, false)
          )
        )
        .limit(1)

      if (existing) return status(409, { message: "Path already exists" })

      const fileId = uuid()
      const kind = body.kind ?? classifyFile(body.path)
      let docId: string | undefined

      if (kind === "text") {
        docId = uuid()
      }

      let revision!: number
      await db.transaction(async (tx) => {
        await tx.insert(fileEntries).values({
          id: fileId,
          workspaceId: params.id,
          path: body.path,
          kind,
          docId: docId ?? null,
        })
        if (docId) {
          await tx.insert(collaborativeDocs).values({
            id: docId,
            workspaceId: params.id,
            fileId,
            updateCount: 0,
          })
          // Initialize Yjs doc inside transaction — always create the initial state
          if (body.content !== undefined) {
            const update = prepareDocUpdate(body.content)
            await tx.insert(yjsUpdates).values({ docId, data: update })
            await tx.execute(
              sql`UPDATE collaborative_docs SET update_count = update_count + 1 WHERE id = ${docId}`
            )
          }
        }
        revision = await incrementRevision(params.id, tx)
      })

      broadcastToWorkspace(params.id, {
        type: "fileCreated",
        workspaceId: params.id,
        fileId,
        path: body.path,
        kind,
        docId: docId ?? undefined,
        revision,
      })

      await recordChange({ workspaceId: params.id, revision, type: "fileCreated", fileId, path: body.path, kind })

      return { id: fileId, path: body.path, kind, docId }
    },
    {
      body: t.Object({
        path: t.String(),
        kind: t.Optional(
          t.Union([t.Literal("text"), t.Literal("binary"), t.Literal("folder")])
        ),
        content: t.Optional(t.String()),
      }),
    }
  )

  // GET /api/v1/workspaces/:id/files/:fileId
  .get("/:fileId", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member) return status(403, { message: "Forbidden" })

    const [file] = await db
      .select()
      .from(fileEntries)
      .where(and(eq(fileEntries.id, params.fileId), eq(fileEntries.deleted, false)))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })
    return file
  })

  // GET /api/v1/workspaces/:id/files/:fileId/content
  .get("/:fileId/content", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member) return status(403, { message: "Forbidden" })

    const [file] = await db
      .select()
      .from(fileEntries)
      .where(and(eq(fileEntries.id, params.fileId), eq(fileEntries.deleted, false)))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })
    if (file.kind !== "text" || !file.docId) return status(400, { message: "Not a text file" })

    const text = await getPlainText(file.docId)
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
  })

  // PATCH /api/v1/workspaces/:id/files/:fileId
  .patch(
    "/:fileId",
    async ({ params, body, user, headers }) => {
      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      const [file] = await db
        .select()
        .from(fileEntries)
        .where(and(eq(fileEntries.id, params.fileId), eq(fileEntries.deleted, false)))
        .limit(1)

      if (!file) return status(404, { message: "File not found" })
      if (!isValidFilePath(body.path)) return status(400, { message: "Invalid file path" })

      const expectedRevision = headers["x-expected-revision"]
      if (expectedRevision) {
        const [ws] = await db
          .select({ revision: workspaces.revision })
          .from(workspaces)
          .where(eq(workspaces.id, params.id))
          .limit(1)
        if (ws && String(ws.revision) !== expectedRevision) {
          return status(409, { message: "Revision conflict" })
        }
      }

      const oldPath = file.path

      await db
        .update(fileEntries)
        .set({ path: body.path, updatedAt: new Date() })
        .where(eq(fileEntries.id, params.fileId))

      const revision = await incrementRevision(params.id)

      broadcastToWorkspace(params.id, {
        type: "fileRenamed",
        workspaceId: params.id,
        fileId: params.fileId,
        path: body.path,
        oldPath,
        revision,
      })

      await recordChange({ workspaceId: params.id, revision, type: "fileRenamed", fileId: params.fileId, path: body.path, oldPath })

      return { fileId: params.fileId, path: body.path, revision }
    },
    { body: t.Object({ path: t.String() }) }
  )

  // DELETE /api/v1/workspaces/:id/files/:fileId
  .delete("/:fileId", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

    const [file] = await db
      .select()
      .from(fileEntries)
      .where(and(eq(fileEntries.id, params.fileId), eq(fileEntries.deleted, false)))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })

    await db
      .update(fileEntries)
      .set({ deleted: true, updatedAt: new Date() })
      .where(eq(fileEntries.id, params.fileId))

    const revision = await incrementRevision(params.id)

    broadcastToWorkspace(params.id, {
      type: "fileDeleted",
      workspaceId: params.id,
      fileId: params.fileId,
      path: file.path,
      revision,
    })

    await recordChange({ workspaceId: params.id, revision, type: "fileDeleted", fileId: params.fileId, path: file.path })

    return { ok: true }
  })
