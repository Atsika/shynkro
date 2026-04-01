import Elysia from "elysia"
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { isShuttingDown } from "../lib/shutdown.js"

export const healthRoutes = new Elysia().get("/api/v1/health", async ({ set }) => {
  if (isShuttingDown()) {
    set.status = 503
    return { status: "shutting_down", apiVersion: 1, minExtensionVersion: "0.1.0", checks: { database: "unknown" } }
  }

  let dbStatus = "ok"
  try {
    await db.execute(sql`SELECT 1`)
  } catch {
    dbStatus = "error"
  }

  if (dbStatus !== "ok") {
    set.status = 503
  }

  return {
    status: dbStatus === "ok" ? "ok" : "degraded",
    apiVersion: 1,
    minExtensionVersion: "0.1.0",
    checks: { database: dbStatus },
  }
})
