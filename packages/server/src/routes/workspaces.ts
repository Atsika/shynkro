import Elysia, { t, status } from "elysia"
import { eq, and, gt, min, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { workspaces, workspaceMembers, fileEntries, workspaceChanges, users } from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { uuid } from "../utils.js"
import { requireMember } from "../lib/authz.js"
import { broadcastToWorkspace } from "../services/realtimeState.js"
import { recordChange } from "../lib/changeLog.js"
import { getPlainText } from "../services/yjsService.js"
import { createStorageBackend } from "../storage/index.js"
import { zipSync } from "fflate"

const storage = createStorageBackend()

async function incrementRevision(workspaceId: string): Promise<number> {
  const result = await db.execute<{ revision: number }>(
    sql`UPDATE workspaces SET revision = revision + 1, updated_at = NOW() WHERE id = ${workspaceId} RETURNING revision`
  )
  return result[0]!.revision
}

export const workspaceRoutes = new Elysia({ prefix: "/api/v1/workspaces" })
  .use(withAuth)

  // POST /api/v1/workspaces
  .post(
    "/",
    async ({ body, user }) => {
      const id = uuid()
      const now = new Date()
      await db.transaction(async (tx) => {
        await tx.insert(workspaces).values({
          id,
          name: body.name,
          ownerId: user.id,
          revision: 0,
          status: "active",
        })
        await tx.insert(workspaceMembers).values({
          workspaceId: id,
          userId: user.id,
          role: "owner",
          acceptedAt: now,
        })
      })

      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
      return ws
    },
    { body: t.Object({ name: t.String({ minLength: 1 }) }) }
  )

  // GET /api/v1/workspaces
  .get("/", async ({ user }) => {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        revision: workspaces.revision,
        status: workspaces.status,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        role: workspaceMembers.role,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .where(eq(workspaces.status, "active"))
    return rows
  })

  // GET /api/v1/workspaces/:id
  .get(
    "/:id",
    async ({ params, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })

      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, params.id))
        .limit(1)

      if (!ws || ws.status === "deleted") return status(404, { message: "Workspace not found" })
      return ws
    }
  )

  // PATCH /api/v1/workspaces/:id — rename
  .patch(
    "/:id",
    async ({ params, body, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })
      if (member.role !== "owner") return status(403, { message: "Only the owner can rename a workspace" })

      const revision = await incrementRevision(params.id)
      await db
        .update(workspaces)
        .set({ name: body.name })
        .where(eq(workspaces.id, params.id))

      await recordChange({ workspaceId: params.id, revision, type: "workspaceRenamed" })
      broadcastToWorkspace(params.id, { type: "workspaceRenamed", workspaceId: params.id, name: body.name })

      return { ok: true }
    },
    { body: t.Object({ name: t.String({ minLength: 1 }) }) }
  )

  // DELETE /api/v1/workspaces/:id
  .delete("/:id", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member) return status(403, { message: "Forbidden" })
    if (member.role !== "owner") return status(403, { message: "Only the owner can delete a workspace" })

    await db
      .update(workspaces)
      .set({ status: "deleted", updatedAt: new Date() })
      .where(eq(workspaces.id, params.id))

    broadcastToWorkspace(params.id, { type: "workspaceDeleted", workspaceId: params.id })

    return { ok: true }
  })

  // GET /api/v1/workspaces/:id/info — public info, no membership required
  .get(
    "/:id/info",
    async ({ params }) => {
      const [row] = await db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          ownerDisplayName: users.username,
        })
        .from(workspaces)
        .innerJoin(users, eq(users.id, workspaces.ownerId))
        .where(and(eq(workspaces.id, params.id), eq(workspaces.status, "active")))
        .limit(1)

      if (!row) return status(404, { message: "Workspace not found" })
      return row
    }
  )

  // POST /api/v1/workspaces/:id/join — join as viewer (no existing membership required)
  .post(
    "/:id/join",
    async ({ params, user }) => {
      const [ws] = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(and(eq(workspaces.id, params.id), eq(workspaces.status, "active")))
        .limit(1)

      if (!ws) return status(404, { message: "Workspace not found" })

      const [existing] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, user.id)))
        .limit(1)

      if (existing) return { role: existing.role, alreadyMember: true }

      await db.insert(workspaceMembers).values({
        workspaceId: params.id,
        userId: user.id,
        role: "viewer",
        acceptedAt: new Date(),
      })

      return { role: "viewer" as const, alreadyMember: false }
    }
  )

  // GET /api/v1/workspaces/:id/tree
  .get(
    "/:id/tree",
    async ({ params, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })

      const files = await db
        .select()
        .from(fileEntries)
        .where(
          and(
            eq(fileEntries.workspaceId, params.id),
            eq(fileEntries.deleted, false)
          )
        )
      return { files }
    }
  )

  // GET /api/v1/workspaces/:id/snapshot
  .get(
    "/:id/snapshot",
    async ({ params, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })

      const [ws] = await db
        .select({ revision: workspaces.revision })
        .from(workspaces)
        .where(eq(workspaces.id, params.id))
        .limit(1)

      if (!ws) return status(404, { message: "Workspace not found" })

      const files = await db
        .select()
        .from(fileEntries)
        .where(
          and(
            eq(fileEntries.workspaceId, params.id),
            eq(fileEntries.deleted, false)
          )
        )

      return {
        revision: ws.revision,
        files: files.map((f) => ({
          fileId: f.id,
          path: f.path,
          kind: f.kind,
          docId: f.docId ?? undefined,
          hash: f.binaryHash ?? undefined,
          size: f.binarySize ?? undefined,
        })),
      }
    }
  )

  // GET /api/v1/workspaces/:id/changes?since=
  .get(
    "/:id/changes",
    async ({ params, query, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })

      // For MVP we return the full tree as "changes" when since=0
      // A proper change log table would be added in Phase 2
      const since = Math.max(0, parseInt(query.since ?? "0", 10) || 0)

      const [ws] = await db
        .select({ revision: workspaces.revision })
        .from(workspaces)
        .where(eq(workspaces.id, params.id))
        .limit(1)

      if (!ws) return status(404, { message: "Workspace not found" })

      // 410 Gone if the client's revision has been pruned from the change log
      if (since > 0) {
        const [minRow] = await db
          .select({ minRev: min(workspaceChanges.revision) })
          .from(workspaceChanges)
          .where(eq(workspaceChanges.workspaceId, params.id))
        if (minRow?.minRev != null && minRow.minRev > since) {
          return status(410, { message: "Revision too old. Re-sync from revision 0." })
        }
      }

      // Full re-sync if since is 0
      if (since === 0) {
        const files = await db
          .select()
          .from(fileEntries)
          .where(
            and(
              eq(fileEntries.workspaceId, params.id),
              eq(fileEntries.deleted, false)
            )
          )

        return {
          currentRevision: ws.revision,
          changes: files.map((f) => ({
            revision: ws.revision,
            type: "fileCreated" as const,
            fileId: f.id,
            path: f.path,
            kind: f.kind,
            docId: f.docId ?? undefined,
            hash: f.binaryHash ?? undefined,
            size: f.binarySize ?? undefined,
          })),
        }
      }

      // Incremental: return change log entries since the given revision
      const rows = await db
        .select()
        .from(workspaceChanges)
        .where(
          and(
            eq(workspaceChanges.workspaceId, params.id),
            gt(workspaceChanges.revision, since)
          )
        )
        .orderBy(workspaceChanges.revision)

      return {
        currentRevision: ws.revision,
        changes: rows.map((r) => ({
          revision: r.revision,
          type: r.type as import("@shynkro/shared").WorkspaceChange["type"],
          fileId: r.fileId ?? undefined,
          path: r.path ?? undefined,
          oldPath: r.oldPath ?? undefined,
          kind: r.kind as import("@shynkro/shared").FileKind | undefined,
          hash: r.hash ?? undefined,
          size: r.size ?? undefined,
        })),
      }
    },
    { query: t.Object({ since: t.Optional(t.String()) }) }
  )

  // GET /api/v1/workspaces/:id/export — download workspace as ZIP
  .get(
    "/:id/export",
    async ({ params, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })

      const files = await db
        .select()
        .from(fileEntries)
        .where(
          and(
            eq(fileEntries.workspaceId, params.id),
            eq(fileEntries.deleted, false)
          )
        )

      const zipEntries: Record<string, [Uint8Array, { level: 0 }]> = {}

      for (const file of files) {
        if (file.kind === "folder") {
          zipEntries[file.path + "/"] = [new Uint8Array(0), { level: 0 }]
        } else if (file.kind === "text" && file.docId) {
          const text = await getPlainText(file.docId)
          zipEntries[file.path] = [new TextEncoder().encode(text), { level: 0 }]
        } else if (file.kind === "binary" && file.binaryHash) {
          const data = await storage.get(file.binaryHash)
          zipEntries[file.path] = [data, { level: 0 }]
        }
      }

      const zipBuffer = Buffer.from(zipSync(zipEntries))
      return new Response(zipBuffer, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="workspace.zip"',
        },
      })
    }
  )
