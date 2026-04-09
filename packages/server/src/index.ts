import { Elysia } from "elysia"
import { healthRoutes } from "./routes/health.js"
import { authRoutes } from "./routes/auth.js"
import { workspaceRoutes } from "./routes/workspaces.js"
import { importRoutes } from "./routes/import.js"
import { fileRoutes } from "./routes/files.js"
import { blobRoutes } from "./routes/blobs.js"
import { memberRoutes } from "./routes/members.js"
import { realtimeRoutes } from "./routes/realtime.js"
import { uploadSessionRoutes } from "./routes/uploadSessions.js"
import { runMigrations, closeDb } from "./db/index.js"
import { expireImportSessions } from "./jobs/expireImportSessions.js"
import { pruneChangeLogs } from "./jobs/pruneChangeLogs.js"
import { purgeRecentOpIds } from "./jobs/purgeRecentOpIds.js"
import { purgeDeletedDocs } from "./jobs/purgeDeletedDocs.js"
import { gcBlobs } from "./jobs/gcBlobs.js"
import { expireUploadSessions } from "./jobs/expireUploadSessions.js"
import {
  closeAllConnections,
  countActiveConnections,
  notifyAllShuttingDown,
} from "./services/realtimeState.js"
import { setupGracefulShutdown } from "./lib/shutdown.js"
import { logger } from "./lib/logger.js"
import {
  REQUEST_ID_HEADER,
  decrementActiveRequests,
  getActiveRequestCount,
  incrementActiveRequests,
  resolveRequestId,
} from "./lib/requestContext.js"

const PORT = parseInt(process.env.PORT ?? "3000", 10)

// Run migrations, then startup jobs
await runMigrations()
await expireImportSessions()
await pruneChangeLogs()
await purgeRecentOpIds()
await purgeDeletedDocs()
await expireUploadSessions()
// gcBlobs is intentionally NOT awaited at startup — listing every blob in a
// large store can take a while and we don't want to block the server's first
// listen() on it. The interval timer picks it up shortly.
const jobInterval = setInterval(() => {
  expireImportSessions().catch((err) => logger.error("expireImportSessions failed", { err: String(err) }))
  pruneChangeLogs().catch((err) => logger.error("pruneChangeLogs failed", { err: String(err) }))
  purgeRecentOpIds().catch((err) => logger.error("purgeRecentOpIds failed", { err: String(err) }))
  purgeDeletedDocs().catch((err) => logger.error("purgeDeletedDocs failed", { err: String(err) }))
  expireUploadSessions().catch((err) => logger.error("expireUploadSessions failed", { err: String(err) }))
  gcBlobs().catch((err) => logger.error("gcBlobs failed", { err: String(err) }))
}, 5 * 60 * 1000)

const app = new Elysia()
  // E1 + E4: per-request bookkeeping. onRequest fires before the handler so
  // we can stamp the request ID into the response headers and count it as
  // in-flight; onAfterResponse decrements once the response has been sent.
  // Both hooks must be paired exactly so the active-request counter stays
  // accurate even when handlers throw.
  .onRequest(({ request, set }) => {
    incrementActiveRequests()
    const id = resolveRequestId(request.headers)
    set.headers[REQUEST_ID_HEADER] = id
  })
  .onAfterResponse(() => {
    decrementActiveRequests()
  })
  .use(healthRoutes)
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(importRoutes)
  .use(fileRoutes)
  .use(blobRoutes)
  .use(uploadSessionRoutes)
  .use(memberRoutes)
  .use(realtimeRoutes)
  .onError(({ code, error, set, request }) => {
    if (code === "NOT_FOUND") {
      set.status = 404
      return { message: "Not found" }
    }
    if (code === "VALIDATION") {
      set.status = 400
      return { message: "Validation error", details: error.message }
    }
    const requestId = request.headers.get(REQUEST_ID_HEADER) ?? undefined
    logger.error("unhandled error", { code, err: String(error), requestId })
    set.status = 500
    return { message: "Internal server error" }
  })
  .listen(PORT)

setupGracefulShutdown({
  server: app.server!,
  intervals: [jobInterval],
  notifyAllConnectionsShuttingDown: notifyAllShuttingDown,
  closeAllConnections,
  activeConnectionCount: countActiveConnections,
  activeRequestCount: getActiveRequestCount,
  closeDb,
})

logger.info("server started", { port: PORT })
