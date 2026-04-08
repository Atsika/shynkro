import { Elysia } from "elysia"
import { healthRoutes } from "./routes/health.js"
import { authRoutes } from "./routes/auth.js"
import { workspaceRoutes } from "./routes/workspaces.js"
import { importRoutes } from "./routes/import.js"
import { fileRoutes } from "./routes/files.js"
import { blobRoutes } from "./routes/blobs.js"
import { memberRoutes } from "./routes/members.js"
import { realtimeRoutes } from "./routes/realtime.js"
import { runMigrations, closeDb } from "./db/index.js"
import { expireImportSessions } from "./jobs/expireImportSessions.js"
import { pruneChangeLogs } from "./jobs/pruneChangeLogs.js"
import { purgeRecentOpIds } from "./jobs/purgeRecentOpIds.js"
import { closeAllConnections } from "./services/realtimeState.js"
import { setupGracefulShutdown } from "./lib/shutdown.js"
import { logger } from "./lib/logger.js"

const PORT = parseInt(process.env.PORT ?? "3000", 10)

// Run migrations, then startup jobs
await runMigrations()
await expireImportSessions()
await pruneChangeLogs()
await purgeRecentOpIds()
const jobInterval = setInterval(() => {
  expireImportSessions().catch((err) => logger.error("expireImportSessions failed", { err: String(err) }))
  pruneChangeLogs().catch((err) => logger.error("pruneChangeLogs failed", { err: String(err) }))
  purgeRecentOpIds().catch((err) => logger.error("purgeRecentOpIds failed", { err: String(err) }))
}, 5 * 60 * 1000)

const app = new Elysia()
  .use(healthRoutes)
  .use(authRoutes)
  .use(workspaceRoutes)
  .use(importRoutes)
  .use(fileRoutes)
  .use(blobRoutes)
  .use(memberRoutes)
  .use(realtimeRoutes)
  .onError(({ code, error, set }) => {
    if (code === "NOT_FOUND") {
      set.status = 404
      return { message: "Not found" }
    }
    if (code === "VALIDATION") {
      set.status = 400
      return { message: "Validation error", details: error.message }
    }
    logger.error("unhandled error", { code, err: String(error) })
    set.status = 500
    return { message: "Internal server error" }
  })
  .listen(PORT)

setupGracefulShutdown({
  server: app.server!,
  intervals: [jobInterval],
  closeAllConnections,
  closeDb,
})

logger.info("server started", { port: PORT })
