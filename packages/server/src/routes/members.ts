import Elysia, { t, status } from "elysia"
import { eq, and } from "drizzle-orm"
import { db } from "../db/index.js"
import { workspaces, workspaceMembers, users } from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { requireMember } from "../lib/authz.js"
import { broadcastToWorkspace, updateClientRole, sendToUser, getWorkspacePresence } from "../services/realtimeState.js"

export const memberRoutes = new Elysia({ prefix: "/api/v1/workspaces/:id/members" })
  .use(withAuth)

  // GET /api/v1/workspaces/:id/members
  .get("/", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member) return status(403, { message: "Forbidden" })

    const rows = await db
      .select({
        userId: workspaceMembers.userId,
        workspaceId: workspaceMembers.workspaceId,
        role: workspaceMembers.role,
        username: users.username,
        acceptedAt: workspaceMembers.acceptedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, params.id))

    return rows
  })

  // POST /api/v1/workspaces/:id/members — invite by username
  .post(
    "/",
    async ({ params, body, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      // Look up the invitee by username
      const [invitee] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, body.username))
        .limit(1)

      if (!invitee) return status(404, { message: "User not found" })

      // Don't allow re-inviting an existing member
      const [existing] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, invitee.id)))
        .limit(1)

      if (existing) return status(409, { message: "User is already a member" })

      await db.insert(workspaceMembers).values({
        workspaceId: params.id,
        userId: invitee.id,
        role: body.role,
        acceptedAt: new Date(),
      })

      sendToUser(params.id, invitee.id, {
        type: "permissionChanged",
        workspaceId: params.id,
        userId: invitee.id,
        role: body.role,
      })

      return { ok: true }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1 }),
        role: t.Union([t.Literal("editor"), t.Literal("viewer")]),
      }),
    }
  )

  // PATCH /api/v1/workspaces/:id/members/:userId — update role
  .patch(
    "/:userId",
    async ({ params, body, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      // Only owner can manage other members' roles
      if (member.role !== "owner") return status(403, { message: "Only the owner can change roles" })

      // Can't change your own role
      if (params.userId === user.id) return status(400, { message: "Cannot change your own role" })

      const [target] = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, params.userId)))
        .limit(1)

      if (!target) return status(404, { message: "Member not found" })
      if (target.role === "owner") return status(400, { message: "Cannot change owner role" })

      // S1: Update in-memory role BEFORE DB write to close the race window
      // where a demoted user's Yjs frames pass the ctx.role check. Revert on
      // DB failure so the in-memory state doesn't drift.
      const previousRole = target.role as "editor" | "viewer"
      updateClientRole(params.id, params.userId, body.role)
      try {
        await db
          .update(workspaceMembers)
          .set({ role: body.role })
          .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, params.userId)))
      } catch (err) {
        updateClientRole(params.id, params.userId, previousRole)
        throw err
      }

      // Notify the affected member of their new role
      sendToUser(params.id, params.userId, {
        type: "permissionChanged",
        workspaceId: params.id,
        userId: params.userId,
        role: body.role,
      })

      // Refresh presence for all members so role icons update
      broadcastToWorkspace(params.id, {
        type: "presenceUpdate",
        workspaceId: params.id,
        users: getWorkspacePresence(params.id),
      })

      return { ok: true }
    },
    {
      body: t.Object({
        role: t.Union([t.Literal("editor"), t.Literal("viewer")]),
      }),
    }
  )

  // DELETE /api/v1/workspaces/:id/members/:userId — remove member
  .delete("/:userId", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member) return status(403, { message: "Forbidden" })

    const isSelf = params.userId === user.id
    // Non-owners can only remove themselves
    if (!isSelf && member.role !== "owner") return status(403, { message: "Forbidden" })

    const [target] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, params.userId)))
      .limit(1)

    if (!target) return status(404, { message: "Member not found" })
    if (target.role === "owner") return status(400, { message: "Cannot remove the workspace owner" })

    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, params.userId)))

    broadcastToWorkspace(params.id, {
      type: "memberRemoved",
      workspaceId: params.id,
    })

    return { ok: true }
  })

  // POST /api/v1/workspaces/:id/members/transfer — transfer ownership
  .post(
    "/transfer",
    async ({ params, body, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member || member.role !== "owner") return status(403, { message: "Only the owner can transfer ownership" })

      if (body.newOwnerId === user.id) return status(400, { message: "Already the owner" })

      const [target] = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, body.newOwnerId)))
        .limit(1)

      if (!target) return status(404, { message: "User is not a member of this workspace" })

      await db.transaction(async (tx) => {
        // Demote current owner to editor
        await tx
          .update(workspaceMembers)
          .set({ role: "editor" })
          .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, user.id)))

        // Promote new owner
        await tx
          .update(workspaceMembers)
          .set({ role: "owner" })
          .where(and(eq(workspaceMembers.workspaceId, params.id), eq(workspaceMembers.userId, body.newOwnerId)))

        // Update workspace ownerId
        await tx
          .update(workspaces)
          .set({ ownerId: body.newOwnerId, updatedAt: new Date() })
          .where(eq(workspaces.id, params.id))
      })

      updateClientRole(params.id, body.newOwnerId, "owner")
      updateClientRole(params.id, user.id, "editor")
      sendToUser(params.id, body.newOwnerId, { type: "permissionChanged", workspaceId: params.id, userId: body.newOwnerId, role: "owner" })
      sendToUser(params.id, user.id, { type: "permissionChanged", workspaceId: params.id, userId: user.id, role: "editor" })
      broadcastToWorkspace(params.id, { type: "presenceUpdate", workspaceId: params.id, users: getWorkspacePresence(params.id) })

      return { ok: true }
    },
    {
      body: t.Object({ newOwnerId: t.String({ minLength: 1 }) }),
    }
  )
