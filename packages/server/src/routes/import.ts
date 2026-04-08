import Elysia, { t, status } from "elysia"
import { eq, and, sql, count } from "drizzle-orm"
import { db } from "../db/index.js"
import {
  collaborativeDocs,
  fileEntries,
  importFiles,
  importSessions,
  workspaces,
  yjsUpdates,
} from "../db/schema.js"
import { withAuth } from "../middleware/auth.js"
import { uuid, addMinutes, isValidFilePath } from "../utils.js"
import { prepareDocUpdate } from "../services/yjsService.js"
import { createStorageBackend } from "../storage/index.js"
import { requireMember } from "../lib/authz.js"
import { logger } from "../lib/logger.js"

const storage = createStorageBackend()

const IMPORT_SESSION_TTL_MINUTES = 30
const MAX_IMPORT_FILES = 5000

/**
 * Per-file size cap for staged import payloads. Anything larger should go through
 * the chunked binary upload path (D1) instead of being base64-stuffed into a JSON
 * body. Default 100 MB; configurable via SHYNKRO_MAX_IMPORT_FILE_SIZE.
 */
const MAX_IMPORT_FILE_BYTES = (() => {
  const raw = process.env.SHYNKRO_MAX_IMPORT_FILE_SIZE
  if (!raw) return 100 * 1024 * 1024
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn("SHYNKRO_MAX_IMPORT_FILE_SIZE not a positive integer, falling back to default", { raw })
    return 100 * 1024 * 1024
  }
  return parsed
})()

/**
 * Total cap on the cumulative size of every staged import file in a single
 * session. Bounds the worst-case memory and DB blob TEXT storage for an init.
 * Default 5 GB; configurable via SHYNKRO_MAX_IMPORT_SESSION_SIZE.
 */
const MAX_IMPORT_SESSION_BYTES = (() => {
  const raw = process.env.SHYNKRO_MAX_IMPORT_SESSION_SIZE
  if (!raw) return 5 * 1024 * 1024 * 1024
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn("SHYNKRO_MAX_IMPORT_SESSION_SIZE not a positive integer, falling back to default", { raw })
    return 5 * 1024 * 1024 * 1024
  }
  return parsed
})()

/**
 * Estimate the byte size of a staged import file's payload. Text files are
 * stored verbatim; binary content is base64 (≈4/3 the byte size of the source).
 * Returns 0 for folders and missing content.
 */
function estimateImportFileBytes(kind: string, content: string | null | undefined): number {
  if (!content || kind === "folder") return 0
  if (kind === "binary") {
    // base64 inflates by 4/3 — back-compute the source bytes from the encoded length.
    return Math.floor((content.length * 3) / 4)
  }
  // Text content is stored as the original string; UTF-8 byte length is what hits
  // the DB column. Buffer.byteLength is exact for any string.
  return Buffer.byteLength(content, "utf-8")
}

export const importRoutes = new Elysia({ prefix: "/api/v1/workspaces/:id/import" })
  .use(withAuth)

  // POST /api/v1/workspaces/:id/import/begin
  .post("/begin", async ({ params, user }) => {
    const member = await requireMember(params.id, user.id)
    if (!member || member.role === "viewer") return status(403, { message: "Forbidden" })

    const sessionId = uuid()
    await db.insert(importSessions).values({
      id: sessionId,
      workspaceId: params.id,
      userId: user.id,
      status: "in_progress",
      expiresAt: addMinutes(IMPORT_SESSION_TTL_MINUTES),
    })

    return { importId: sessionId }
  })

  // POST /api/v1/workspaces/:id/import/:importId/files
  .post(
    "/:importId/files",
    async ({ params, body, user }) => {
      const [session] = await db
        .select()
        .from(importSessions)
        .where(
          and(
            eq(importSessions.id, params.importId),
            eq(importSessions.workspaceId, params.id),
            eq(importSessions.userId, user.id),
            eq(importSessions.status, "in_progress")
          )
        )
        .limit(1)

      if (!session) return status(404, { message: "Import session not found or expired" })
      if (new Date() > session.expiresAt) {
        await db
          .update(importSessions)
          .set({ status: "expired" })
          .where(eq(importSessions.id, params.importId))
        return status(410, { message: "Import session expired" })
      }

      if (!isValidFilePath(body.path)) return status(400, { message: "Invalid file path" })

      // Per-file size cap. The largest legitimate use case is a small project
      // template; anything bigger should be uploaded via the chunked blob path.
      const incomingBytes = estimateImportFileBytes(body.kind, body.content)
      if (incomingBytes > MAX_IMPORT_FILE_BYTES) {
        return status(413, {
          code: "IMPORT_FILE_TOO_LARGE",
          message: `Import file ${body.path} (~${incomingBytes} bytes) exceeds SHYNKRO_MAX_IMPORT_FILE_SIZE=${MAX_IMPORT_FILE_BYTES}. Use the chunked blob upload for large files.`,
        })
      }

      const [{ value: fileCount }] = await db
        .select({ value: count() })
        .from(importFiles)
        .where(eq(importFiles.sessionId, params.importId))

      if (fileCount >= MAX_IMPORT_FILES) {
        return status(400, { message: `Import session cannot exceed ${MAX_IMPORT_FILES} files` })
      }

      // Cumulative session-size cap. Sum the size of every staged file already
      // in this session and reject if adding this one would push past the limit.
      // Cheap COALESCE-around-NULL handles the empty-session case.
      const [sumRow] = await db.execute<{ total: number | null }>(sql`
        SELECT COALESCE(SUM(
          CASE
            WHEN kind = 'binary' THEN floor(length(coalesce(content, '')) * 3 / 4)
            WHEN kind = 'text'   THEN octet_length(coalesce(content, ''))
            ELSE 0
          END
        ), 0)::bigint AS total
        FROM import_files
        WHERE session_id = ${params.importId}
      `)
      const currentTotal = Number(sumRow?.total ?? 0)
      if (currentTotal + incomingBytes > MAX_IMPORT_SESSION_BYTES) {
        return status(413, {
          code: "IMPORT_SESSION_TOO_LARGE",
          message: `Import session would exceed SHYNKRO_MAX_IMPORT_SESSION_SIZE=${MAX_IMPORT_SESSION_BYTES} (current ${currentTotal}, this file ~${incomingBytes}). Split the workspace or use the chunked blob upload for large binaries.`,
        })
      }

      const fileId = uuid()
      // Upsert by path (idempotent)
      await db
        .insert(importFiles)
        .values({
          id: fileId,
          sessionId: params.importId,
          path: body.path,
          kind: body.kind,
          content: body.content ?? null,
          hash: body.hash ?? null,
        })
        .onConflictDoUpdate({
          target: [importFiles.sessionId, importFiles.path],
          set: { kind: body.kind, content: body.content ?? null, hash: body.hash ?? null },
        })

      return { ok: true }
    },
    {
      body: t.Object({
        path: t.String(),
        kind: t.Union([t.Literal("text"), t.Literal("binary"), t.Literal("folder")]),
        content: t.Optional(t.String()),
        hash: t.Optional(t.String()),
      }),
    }
  )

  // POST /api/v1/workspaces/:id/import/:importId/commit
  .post("/:importId/commit", async ({ params, user }) => {
    const [session] = await db
      .select()
      .from(importSessions)
      .where(
        and(
          eq(importSessions.id, params.importId),
          eq(importSessions.workspaceId, params.id),
          eq(importSessions.userId, user.id),
          eq(importSessions.status, "in_progress")
        )
      )
      .limit(1)

    if (!session) return status(404, { message: "Import session not found" })

    const staged = await db
      .select()
      .from(importFiles)
      .where(eq(importFiles.sessionId, params.importId))

    // Store binary blobs BEFORE the DB transaction — if storage fails, abort early
    for (const file of staged) {
      if (file.kind === "binary" && file.content && file.hash && /^[0-9a-f]{64}$/.test(file.hash)) {
        const data = Buffer.from(file.content, "base64")
        await storage.put(file.hash, data)
      }
    }

    await db.transaction(async (tx) => {
      for (const file of staged) {
        const fileId = uuid()
        let docId: string | undefined

        if (file.kind === "text") {
          docId = uuid()
        }

        // Insert file entry first (collaborative_docs has FK to file_entries)
        await tx.insert(fileEntries).values({
          id: fileId,
          workspaceId: params.id,
          path: file.path,
          kind: file.kind,
          docId: docId ?? null,
          binaryHash: file.hash ?? null,
        })

        if (docId) {
          await tx.insert(collaborativeDocs).values({
            id: docId,
            workspaceId: params.id,
            fileId,
            updateCount: 0,
          })
          // Initialize Yjs doc inside the transaction — always create initial state
          if (file.content !== undefined && file.content !== null) {
            const update = prepareDocUpdate(file.content)
            await tx.insert(yjsUpdates).values({ docId, data: update })
            await tx.execute(
              sql`UPDATE collaborative_docs SET update_count = update_count + 1 WHERE id = ${docId}`
            )
          }
        }
      }

      await tx.execute(
        sql`UPDATE workspaces SET revision = revision + 1, updated_at = NOW() WHERE id = ${params.id}`
      )

      await tx
        .update(importSessions)
        .set({ status: "committed" })
        .where(eq(importSessions.id, params.importId))
    })

    return { ok: true }
  })

  // POST /api/v1/workspaces/:id/import/:importId/abort
  .post("/:importId/abort", async ({ params, user }) => {
    const [session] = await db
      .select()
      .from(importSessions)
      .where(
        and(
          eq(importSessions.id, params.importId),
          eq(importSessions.workspaceId, params.id),
          eq(importSessions.userId, user.id)
        )
      )
      .limit(1)

    if (!session) return status(404, { message: "Import session not found" })

    await db.transaction(async (tx) => {
      await tx.delete(importFiles).where(eq(importFiles.sessionId, params.importId))
      await tx
        .update(importSessions)
        .set({ status: "aborted" })
        .where(eq(importSessions.id, params.importId))
    })

    return { ok: true }
  })
