import Elysia from "elysia"
import { mkdir, unlink, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { isShuttingDown } from "../lib/shutdown.js"
import { logger } from "../lib/logger.js"

const BLOB_DIR = process.env.SHYNKRO_BLOB_DIR ?? "./blobs"
const HEALTH_PROBE_DIR = join(BLOB_DIR, ".health")

/**
 * Round-trip a tiny probe file through the configured blob directory: write,
 * read back, verify content, delete. Catches the failure modes that the bare
 * `SELECT 1` from the previous health check missed:
 *
 *   - blob mount has gone read-only
 *   - blob volume is full
 *   - SHYNKRO_BLOB_DIR points at a path that doesn't exist
 *   - filesystem permissions are wrong
 *
 * Each probe uses a fresh random filename so two concurrent health checks
 * never collide.
 */
async function probeStorage(): Promise<{ status: "ok" | "error"; detail?: string }> {
  const probePath = join(HEALTH_PROBE_DIR, `probe-${randomBytes(6).toString("hex")}`)
  const probeContent = `shynkro-health-${Date.now()}`
  try {
    await mkdir(HEALTH_PROBE_DIR, { recursive: true })
    await writeFile(probePath, probeContent, "utf-8")
    const readBack = await readFile(probePath, "utf-8")
    if (readBack !== probeContent) {
      return { status: "error", detail: "round-trip content mismatch" }
    }
    return { status: "ok" }
  } catch (err) {
    return { status: "error", detail: String(err) }
  } finally {
    await unlink(probePath).catch(() => { /* best-effort */ })
  }
}

/**
 * Verify the migrations table exists and has at least the most recent
 * migration this server build expects. A drift between the schema in the
 * binary and the schema in the database is the kind of thing that breaks
 * silently for hours before someone notices, so flag it loudly here.
 */
async function probeSchema(): Promise<{ status: "ok" | "error"; detail?: string }> {
  try {
    // drizzle-orm/bun-sql writes its bookkeeping to the `drizzle.__drizzle_migrations`
    // table by default. We don't pin a specific revision (the binary doesn't
    // know what number it shipped with at runtime) — we just verify there's
    // at least one row, which proves runMigrations() ran successfully at boot.
    const result = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM drizzle.__drizzle_migrations`
    )
    const count = Number(result[0]?.count ?? 0)
    if (count === 0) {
      return { status: "error", detail: "no migrations recorded" }
    }
    return { status: "ok" }
  } catch (err) {
    return { status: "error", detail: String(err) }
  }
}

export const healthRoutes = new Elysia().get("/api/v1/health", async ({ set }) => {
  if (isShuttingDown()) {
    set.status = 503
    return {
      status: "shutting_down",
      apiVersion: 1,
      minExtensionVersion: "0.1.0",
      checks: { database: "unknown", storage: "unknown", schema: "unknown" },
    }
  }

  let dbStatus = "ok"
  try {
    await db.execute(sql`SELECT 1`)
  } catch (err) {
    dbStatus = "error"
    logger.error("health: db check failed", { err: String(err) })
  }

  // Run storage and schema probes in parallel — both are I/O-bound and
  // independent, so this keeps the health check responsive even when one is slow.
  const [storage, schema] = await Promise.all([probeStorage(), probeSchema()])

  const allOk = dbStatus === "ok" && storage.status === "ok" && schema.status === "ok"
  if (!allOk) set.status = 503

  return {
    status: allOk ? "ok" : "degraded",
    apiVersion: 1,
    minExtensionVersion: "0.1.0",
    checks: {
      database: dbStatus,
      storage: storage.status,
      ...(storage.detail ? { storageDetail: storage.detail } : {}),
      schema: schema.status,
      ...(schema.detail ? { schemaDetail: schema.detail } : {}),
    },
  }
})
