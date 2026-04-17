import Elysia, { t, status } from "elysia"
import { eq, and, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { workspaces, workspaceMembers, fileEntries, users } from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { uuid } from "../utils.js"
import { requireMember } from "../lib/authz.js"
import { broadcastToWorkspace, disconnectWorkspaceClients } from "../services/realtimeState.js"
import { recordChange } from "../lib/changeLog.js"

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

      // S6: Wrap rename + revision bump + changelog in a single transaction so
      // a concurrent /changes poller can never observe a revision bump without
      // the corresponding workspaceRenamed entry.
      const revision = await db.transaction(async (tx) => {
        await tx
          .update(workspaces)
          .set({ name: body.name })
          .where(eq(workspaces.id, params.id))
        const [{ revision: rev }] = await tx.execute<{ revision: number }>(
          sql`UPDATE workspaces SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.id} RETURNING revision`
        )
        await recordChange({ workspaceId: params.id, revision: rev, type: "workspaceRenamed" }, tx)
        return rev
      })
      void revision
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
    // S7: Force-close WS connections so clients can't keep pushing Yjs updates
    disconnectWorkspaceClients(params.id)

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

      // S8: Use ON CONFLICT to avoid TOCTOU between existence check and insert.
      // If two concurrent joins hit this, one inserts and the other no-ops.
      const result = await db
        .insert(workspaceMembers)
        .values({
          workspaceId: params.id,
          userId: user.id,
          role: "viewer",
          acceptedAt: new Date(),
        })
        .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] })
        .returning({ role: workspaceMembers.role })

      if (result.length > 0) {
        return { role: "viewer" as const, alreadyMember: false }
      }
      // Already a member — fetch existing role
      const [existing] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, user.id)))
        .limit(1)
      return { role: existing!.role, alreadyMember: true }
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

