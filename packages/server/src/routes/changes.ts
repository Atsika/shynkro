import Elysia, { t, status } from "elysia"
import { eq, and, gt, min } from "drizzle-orm"
import { db } from "../db/index.js"
import { workspaces, fileEntries, workspaceChanges } from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { requireMember } from "../lib/authz.js"

export const changeRoutes = new Elysia({ prefix: "/api/v1/workspaces" })
  .use(withAuth)

  // GET /api/v1/workspaces/:id/changes?since=&limit=&offset=
  //
  // Pagination: `limit` caps how many change rows come back in a single request
  // (default 1000, max 5000). `offset` is applied on top of the `since > N`
  // filter so the client can stream further pages until empty. Response carries
  // `hasMore: boolean` so clients know whether to keep paging. Prevents OOM
  // when a long-offline client reconnects against a workspace with millions
  // of change rows.
  .get(
    "/:id/changes",
    async ({ params, query, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })

      const since = Math.max(0, parseInt(query.since ?? "0", 10) || 0)
      const requestedLimit = parseInt(query.limit ?? "1000", 10) || 1000
      const limit = Math.max(1, Math.min(5000, requestedLimit))
      const offset = Math.max(0, parseInt(query.offset ?? "0", 10) || 0)

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

      // Full re-sync if since is 0. The file list is bounded by the workspace
      // size (not the change history), so pagination isn't strictly required
      // here — but we still respect `limit` so very large workspaces don't
      // blow the response size.
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
          .orderBy(fileEntries.id)
          .limit(limit + 1)
          .offset(offset)

        const hasMore = files.length > limit
        const page = hasMore ? files.slice(0, limit) : files

        return {
          currentRevision: ws.revision,
          hasMore,
          nextOffset: hasMore ? offset + limit : null,
          changes: page.map((f) => ({
            revision: ws.revision,
            type: "fileCreated" as const,
            fileId: f.id,
            path: f.path,
            kind: f.kind,
            docId: f.docId ?? undefined,
            hash: f.binaryHash ?? undefined,
            size: f.binarySize ?? undefined,
            mode: f.mode ?? undefined,
          })),
        }
      }

      // Incremental: return change log entries since the given revision,
      // paginated. Left-join file_entries so fileCreated entries carry docId
      // (the change log table doesn't store it, but the reconciler needs it
      // to set up Yjs subscriptions for text files).
      const rows = await db
        .select({
          revision: workspaceChanges.revision,
          type: workspaceChanges.type,
          fileId: workspaceChanges.fileId,
          path: workspaceChanges.path,
          oldPath: workspaceChanges.oldPath,
          kind: workspaceChanges.kind,
          hash: workspaceChanges.hash,
          size: workspaceChanges.size,
          docId: fileEntries.docId,
          mode: fileEntries.mode,
        })
        .from(workspaceChanges)
        .leftJoin(fileEntries, eq(fileEntries.id, workspaceChanges.fileId))
        .where(
          and(
            eq(workspaceChanges.workspaceId, params.id),
            gt(workspaceChanges.revision, since)
          )
        )
        .orderBy(workspaceChanges.revision)
        .limit(limit + 1)
        .offset(offset)

      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows

      return {
        currentRevision: ws.revision,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
        changes: page.map((r) => ({
          revision: r.revision,
          type: r.type as import("@shynkro/shared").WorkspaceChange["type"],
          fileId: r.fileId ?? undefined,
          path: r.path ?? undefined,
          oldPath: r.oldPath ?? undefined,
          kind: r.kind as import("@shynkro/shared").FileKind | undefined,
          hash: r.hash ?? undefined,
          size: r.size ?? undefined,
          docId: r.docId ?? undefined,
          mode: r.mode ?? undefined,
        })),
      }
    },
    {
      query: t.Object({
        since: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        offset: t.Optional(t.String()),
      }),
    }
  )
