import Elysia, { t, status } from "elysia"
import { eq, and, sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { activeFileById } from "../db/predicates.js"
import {
  collaborativeDocs,
  fileEntries,
  workspaces,
  yjsUpdates,
} from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { broadcastToWorkspace, broadcastToDoc } from "../services/realtimeState.js"
import { getPlainText, prepareDocUpdate, forceSetDocContent, DocCorruptedError, DocDeletedError } from "../services/yjsService.js"
import { uuid, isValidFilePath } from "../utils.js"
import { classifyFile, classifyFileWithContent } from "@shynkro/shared"
import { requireMember } from "../lib/authz.js"
import { recordChange } from "../lib/changeLog.js"
import { createStorageBackend } from "../storage/index.js"
import { logger } from "../lib/logger.js"
import { readIdempotencyCache, writeIdempotencyCache, getOpIdHeader } from "../lib/idempotency.js"

const storage = createStorageBackend()

/**
 * Detect a Postgres unique-constraint violation, optionally narrowing to a specific
 * index name. Used so case-collision races on file_entries surface as 409s, not 500s.
 */
function isUniqueViolation(err: unknown, indexName?: string): boolean {
  if (typeof err !== "object" || err === null) return false
  const e = err as { code?: string; constraint?: string; message?: string }
  if (e.code !== "23505") return false
  if (!indexName) return true
  return e.constraint === indexName || (typeof e.message === "string" && e.message.includes(indexName))
}

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
    async ({ params, body, user, headers }) => {
      const opId = getOpIdHeader(headers)
      if (opId) {
        const cached = await readIdempotencyCache(params.id, opId)
        if (cached) return status(cached.status, cached.body)
      }

      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      if (!isValidFilePath(body.path)) return status(400, { message: "Invalid file path" })

      // Case-insensitive uniqueness pre-check — produces a clear error message before
      // hitting the partial unique index. The DB constraint is the source of truth.
      const [existing] = await db
        .select({ id: fileEntries.id, path: fileEntries.path })
        .from(fileEntries)
        .where(
          and(
            eq(fileEntries.workspaceId, params.id),
            sql`lower(${fileEntries.path}) = lower(${body.path})`,
            eq(fileEntries.deleted, false)
          )
        )
        .limit(1)

      if (existing) {
        if (existing.path === body.path) {
          return status(409, { message: "Path already exists" })
        }
        return status(409, {
          code: "PATH_CASE_COLLISION",
          message: `Path collides with existing file "${existing.path}" — paths are compared case-insensitively across collaborators.`,
        })
      }

      const fileId = uuid()
      const kind = body.kind
        ?? classifyFile(body.path)
        ?? (body.content ? classifyFileWithContent(body.path, Buffer.from(body.content)) : "text")
      let docId: string | undefined

      if (kind === "text") {
        docId = uuid()
      }

      // Sanitize mode bits — never trust the client past the POSIX mode mask.
      const mode = typeof body.mode === "number" ? body.mode & 0o777 : null

      let revision!: number
      try {
        await db.transaction(async (tx) => {
          await tx.insert(fileEntries).values({
            id: fileId,
            workspaceId: params.id,
            path: body.path,
            kind,
            docId: docId ?? null,
            mode,
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
      } catch (err) {
        // Race: two clients creating files with case-equivalent paths land here when the
        // pre-check passed. The unique index catches it.
        if (isUniqueViolation(err, "file_entries_ws_path_ci_idx")) {
          return status(409, {
            code: "PATH_CASE_COLLISION",
            message: `Path "${body.path}" collides case-insensitively with an existing file in this workspace.`,
          })
        }
        throw err
      }

      broadcastToWorkspace(params.id, {
        type: "fileCreated",
        workspaceId: params.id,
        fileId,
        path: body.path,
        kind,
        docId: docId ?? undefined,
        mode,
        revision,
      })

      await recordChange({ workspaceId: params.id, revision, type: "fileCreated", fileId, path: body.path, kind })

      const response = { id: fileId, path: body.path, kind, docId, mode }
      if (opId) await writeIdempotencyCache(params.id, opId, 200, response)
      return response
    },
    {
      body: t.Object({
        path: t.String(),
        kind: t.Optional(
          t.Union([t.Literal("text"), t.Literal("binary"), t.Literal("folder")])
        ),
        content: t.Optional(t.String()),
        mode: t.Optional(t.Number()),
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
      .where(activeFileById(params.fileId))
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
      .where(activeFileById(params.fileId))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })
    if (file.kind !== "text" || !file.docId) return status(400, { message: "Not a text file" })

    try {
      const text = await getPlainText(file.docId)
      return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
    } catch (err) {
      if (err instanceof DocCorruptedError) {
        return status(503, {
          code: "DOC_CORRUPTED",
          message: err.message,
        })
      }
      if (err instanceof DocDeletedError) {
        return status(410, {
          code: "DOC_DELETED",
          message: err.message,
        })
      }
      throw err
    }
  })

  // PUT /api/v1/workspaces/:id/files/:fileId/content
  // Force-sets the Yjs document to the given text, bypassing CRDT merge.
  // Used exclusively by conflict resolution to establish the user's chosen text
  // as the new authoritative server state and broadcast it to all subscribers.
  .put(
    "/:fileId/content",
    async ({ params, body, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      const [file] = await db
        .select()
        .from(fileEntries)
        .where(activeFileById(params.fileId))
        .limit(1)

      if (!file) return status(404, { message: "File not found" })
      if (file.kind !== "text" || !file.docId) return status(400, { message: "Not a text file" })

      try {
        const newState = await forceSetDocContent(file.docId, body.text)

        // Broadcast the new canonical state as WS_BINARY_YJS_STATE (frame type 0x02)
        // so all subscribers replace their Yjs doc with this clean state.
        const docIdBytes = Buffer.from(file.docId.replace(/-/g, ""), "hex")
        const frame = new Uint8Array(1 + 16 + newState.length)
        frame[0] = 0x02  // WS_BINARY_YJS_STATE
        frame.set(docIdBytes, 1)
        frame.set(newState, 17)
        broadcastToDoc(file.docId, frame)

        return { ok: true }
      } catch (err) {
        if (err instanceof DocCorruptedError) return status(503, { code: "DOC_CORRUPTED", message: err.message })
        if (err instanceof DocDeletedError) return status(410, { code: "DOC_DELETED", message: err.message })
        throw err
      }
    },
    { body: t.Object({ text: t.String() }) }
  )

  // PATCH /api/v1/workspaces/:id/files/:fileId
  .patch(
    "/:fileId",
    async ({ params, body, user, headers }) => {
      const opId = getOpIdHeader(headers)
      if (opId) {
        const cached = await readIdempotencyCache(params.id, opId)
        if (cached) return status(cached.status, cached.body)
      }

      const member = await requireMember(params.id, user.id)
      if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

      const [file] = await db
        .select()
        .from(fileEntries)
        .where(activeFileById(params.fileId))
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
      const isFolder = file.kind === "folder"
      const oldPrefix = oldPath + "/"
      const newPrefix = body.path + "/"

      // Reject renaming a folder into its own descendant (would create an
      // unreachable cycle and leave orphaned paths after the cascade).
      if (isFolder && body.path.startsWith(oldPrefix)) {
        return status(400, { message: "Cannot rename a folder into its own descendant" })
      }

      // Pre-check case-insensitive collision with any *other* live file in this workspace.
      const [collision] = await db
        .select({ id: fileEntries.id, path: fileEntries.path })
        .from(fileEntries)
        .where(
          and(
            eq(fileEntries.workspaceId, params.id),
            sql`lower(${fileEntries.path}) = lower(${body.path})`,
            sql`${fileEntries.id} <> ${params.fileId}`,
            eq(fileEntries.deleted, false)
          )
        )
        .limit(1)
      if (collision) {
        return status(409, {
          code: "PATH_CASE_COLLISION",
          message: `Cannot rename to "${body.path}" — collides with existing file "${collision.path}".`,
        })
      }

      // Folder renames must drag every descendant along. Gather them now so we
      // can (a) pre-check for collisions with non-descendant files at the
      // target prefix, and (b) broadcast a fileRenamed for each descendant
      // after the transaction commits.
      type DescendantRename = { fileId: string; oldPath: string; newPath: string }
      let descendants: DescendantRename[] = []
      if (isFolder) {
        const rows = await db
          .select({ id: fileEntries.id, path: fileEntries.path })
          .from(fileEntries)
          .where(
            and(
              eq(fileEntries.workspaceId, params.id),
              eq(fileEntries.deleted, false),
              sql`${fileEntries.path} LIKE ${oldPrefix + "%"}`
            )
          )
        descendants = rows.map((r) => ({
          fileId: r.id,
          oldPath: r.path,
          newPath: newPrefix + r.path.slice(oldPrefix.length),
        }))

        // Collision check: any non-descendant live file whose path matches a
        // target descendant path (case-insensitive) would collide after the
        // cascade. Descendants themselves are excluded via the NOT LIKE clause
        // so a pure case-only folder rename (foo → FOO) is allowed.
        if (descendants.length > 0) {
          const targetsLower = descendants.map((d) => d.newPath.toLowerCase())
          const [descCollision] = await db
            .select({ path: fileEntries.path })
            .from(fileEntries)
            .where(
              and(
                eq(fileEntries.workspaceId, params.id),
                eq(fileEntries.deleted, false),
                sql`lower(${fileEntries.path}) = ANY(${targetsLower})`,
                sql`${fileEntries.path} NOT LIKE ${oldPrefix + "%"}`,
                sql`${fileEntries.id} <> ${params.fileId}`
              )
            )
            .limit(1)
          if (descCollision) {
            return status(409, {
              code: "PATH_CASE_COLLISION",
              message: `Cannot rename folder to "${body.path}" — would collide with existing file "${descCollision.path}".`,
            })
          }
        }
      }

      // Concurrency note: the collision pre-check runs *outside* this transaction, so
      // a racing INSERT / UPDATE can still land between the check and the UPDATE. The
      // partial unique index `file_entries_ws_path_ci_idx` is the source of truth for
      // correctness — the try/catch below catches the 23505 raised by Postgres when
      // that race loses. Switching to SERIALIZABLE here would replace the 23505 with a
      // 40001 serialization failure, requiring client retries, without actually
      // improving the user-visible outcome; left at the default READ COMMITTED.
      let revision!: number
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(fileEntries)
            .set({ path: body.path, updatedAt: new Date() })
            .where(eq(fileEntries.id, params.fileId))
          // Cascade descendant paths (folder rename). One bulk UPDATE by
          // rewriting only the leading prefix; trailing slashes on oldPrefix /
          // newPrefix guarantee we don't match a same-prefix sibling like
          // "foobar/" when renaming "foo/".
          if (isFolder && descendants.length > 0) {
            await tx.execute(
              sql`UPDATE file_entries
                  SET path = ${newPrefix} || substring(path from ${oldPrefix.length + 1}),
                      updated_at = NOW()
                  WHERE workspace_id = ${params.id}
                    AND deleted = false
                    AND path LIKE ${oldPrefix + "%"}`
            )
          }
          revision = await incrementRevision(params.id, tx)
        })
      } catch (err) {
        if (isUniqueViolation(err, "file_entries_ws_path_ci_idx")) {
          return status(409, {
            code: "PATH_CASE_COLLISION",
            message: `Cannot rename to "${body.path}" — collides case-insensitively with an existing file.`,
          })
        }
        throw err
      }

      broadcastToWorkspace(params.id, {
        type: "fileRenamed",
        workspaceId: params.id,
        fileId: params.fileId,
        path: body.path,
        oldPath,
        revision,
      })
      await recordChange({ workspaceId: params.id, revision, type: "fileRenamed", fileId: params.fileId, path: body.path, oldPath })

      // Broadcast and log a fileRenamed for each descendant so every peer's
      // changeReconciler can apply the move locally. They share the same
      // revision as the parent rename — one atomic batch.
      for (const d of descendants) {
        broadcastToWorkspace(params.id, {
          type: "fileRenamed",
          workspaceId: params.id,
          fileId: d.fileId,
          path: d.newPath,
          oldPath: d.oldPath,
          revision,
        })
        await recordChange({
          workspaceId: params.id,
          revision,
          type: "fileRenamed",
          fileId: d.fileId,
          path: d.newPath,
          oldPath: d.oldPath,
        })
      }

      const response = { fileId: params.fileId, path: body.path, revision }
      if (opId) await writeIdempotencyCache(params.id, opId, 200, response)
      return response
    },
    { body: t.Object({ path: t.String() }) }
  )

  // DELETE /api/v1/workspaces/:id/files/:fileId
  .delete("/:fileId", async ({ params, user, headers }) => {
    const opId = getOpIdHeader(headers)
    if (opId) {
      const cached = await readIdempotencyCache(params.id, opId)
      if (cached) return status(cached.status, cached.body)
    }

    const member = await requireMember(params.id, user.id)
    if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

    const [file] = await db
      .select()
      .from(fileEntries)
      .where(activeFileById(params.fileId))
      .limit(1)

    if (!file) return status(404, { message: "File not found" })

    let revision!: number
    await db.transaction(async (tx) => {
      await tx
        .update(fileEntries)
        .set({ deleted: true, updatedAt: new Date() })
        .where(eq(fileEntries.id, params.fileId))
      // Soft-delete the linked collaborative doc so the purge job can later clean
      // up yjs_updates on its own schedule (default 30 days). The file_entries FK
      // has onDelete:cascade, but we never hard-delete file_entries, so without
      // this UPDATE the doc would never get cleaned up and an accidental deletion
      // would still be recoverable — but also would never be purged.
      if (file.docId) {
        await tx
          .update(collaborativeDocs)
          .set({ deletedAt: new Date() })
          .where(eq(collaborativeDocs.id, file.docId))
      }
      revision = await incrementRevision(params.id, tx)
    })

    // Blob cleanup is delegated to gcBlobs (D8). The previous unconditional
    // best-effort delete here was unsafe — if another file deduped onto the
    // same hash, deleting it would silently break that other file. The
    // orphan-GC job checks reference state safely under a grace period and
    // also gives the soft-delete recovery window time to work, since soft-
    // deleted file_entries rows still keep their binary_hash populated and
    // therefore still count as references during the recovery period.

    broadcastToWorkspace(params.id, {
      type: "fileDeleted",
      workspaceId: params.id,
      fileId: params.fileId,
      path: file.path,
      revision,
    })

    await recordChange({ workspaceId: params.id, revision, type: "fileDeleted", fileId: params.fileId, path: file.path })

    const response = { ok: true }
    if (opId) await writeIdempotencyCache(params.id, opId, 200, response)
    return response
  })
