import { Elysia } from "elysia"
import { cors } from "@elysiajs/cors"
import { healthRoutes } from "./routes/health.js"
import { authRoutes } from "./routes/auth.js"
import { workspaceRoutes } from "./routes/workspaces.js"
import { importRoutes } from "./routes/import.js"
import { fileRoutes } from "./routes/files.js"
import { blobRoutes } from "./routes/blobs.js"
import { memberRoutes } from "./routes/members.js"
import { realtimeRoutes } from "./routes/realtime.js"
import { expireImportSessions } from "./jobs/expireImportSessions.js"
import { pruneChangeLogs } from "./jobs/pruneChangeLogs.js"

const PORT = parseInt(process.env.PORT ?? "3000", 10)

// Run startup jobs
await expireImportSessions()
await pruneChangeLogs()
setInterval(() => {
  expireImportSessions().catch(console.error)
  pruneChangeLogs().catch(console.error)
}, 5 * 60 * 1000)

const app = new Elysia()
  .use(cors())
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
    console.error("[server] Unhandled error:", error)
    set.status = 500
    return { message: "Internal server error" }
  })
  .listen(PORT)

console.log(`Shynkro server running on http://localhost:${PORT}`)
