import Elysia, { status } from "elysia"
import { db } from "../db/index.js"
import { fileEntries } from "../db/schema.js"
import { activeFilesInWorkspace } from "../db/predicates.js"
import { withAuth } from "../middleware/auth.js"
import { requireMember } from "../lib/authz.js"
import { getPlainText, DocCorruptedError, DocDeletedError } from "../services/yjsService.js"
import { createStorageBackend } from "../storage/index.js"
import { zipSync } from "fflate"
import { envInt } from "../lib/envInt.js"

const storage = createStorageBackend()

/** Max uncompressed bytes an export may accumulate. Default 1 GB. */
const MAX_EXPORT_BYTES = envInt("SHYNKRO_MAX_EXPORT_BYTES", 1024 * 1024 * 1024)

export const exportRoutes = new Elysia({ prefix: "/api/v1/workspaces" })
  .use(withAuth)

  // GET /api/v1/workspaces/:id/export — download workspace as ZIP
  .get(
    "/:id/export",
    async ({ params, user }) => {
      const member = await requireMember(params.id, user.id)
      if (!member) return status(403, { message: "Forbidden" })

      const files = await db
        .select()
        .from(fileEntries)
        .where(activeFilesInWorkspace(params.id))

      const zipEntries: Record<string, [Uint8Array, { level: 0 }]> = {}
      let accumulated = 0

      try {
        for (const file of files) {
          if (file.kind === "folder") {
            zipEntries[file.path + "/"] = [new Uint8Array(0), { level: 0 }]
          } else if (file.kind === "text" && file.docId) {
            const text = await getPlainText(file.docId)
            const bytes = new TextEncoder().encode(text)
            accumulated += bytes.length
            if (accumulated > MAX_EXPORT_BYTES) {
              return status(413, {
                code: "EXPORT_TOO_LARGE",
                message: `Export exceeds SHYNKRO_MAX_EXPORT_BYTES=${MAX_EXPORT_BYTES}. Split the workspace or raise the cap.`,
              })
            }
            zipEntries[file.path] = [bytes, { level: 0 }]
          } else if (file.kind === "binary" && file.binaryHash) {
            accumulated += file.binarySize ?? 0
            if (accumulated > MAX_EXPORT_BYTES) {
              return status(413, {
                code: "EXPORT_TOO_LARGE",
                message: `Export exceeds SHYNKRO_MAX_EXPORT_BYTES=${MAX_EXPORT_BYTES}. Split the workspace or raise the cap.`,
              })
            }
            const data = await storage.get(file.binaryHash)
            zipEntries[file.path] = [data, { level: 0 }]
          }
        }
      } catch (err) {
        // Refuse to emit a partial export — a silently-empty entry in the archive
        // would let a pentester think they have their data when they actually lost
        // the content of a corrupted or already-soft-deleted doc. Bail loudly with
        // a clear error code in both cases.
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

      const zipBuffer = Buffer.from(zipSync(zipEntries))
      return new Response(zipBuffer, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="workspace.zip"',
        },
      })
    }
  )
