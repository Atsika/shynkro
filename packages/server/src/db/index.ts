import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import * as schema from "./schema.js"
import { logger } from "../lib/logger.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is not set")

/**
 * Connection pool sizing (E3). Configurable via env so a heavily-loaded
 * deployment can bump the ceiling without a code change. The defaults are
 * sized for the pentester team threat model — small enough that an idle
 * server doesn't hold a wedge of Postgres connections open, large enough
 * that an init/clone burst doesn't queue.
 *
 *   SHYNKRO_DB_POOL_MAX     default 20  — hard ceiling on concurrent connections
 *   SHYNKRO_DB_IDLE_TIMEOUT default 30  — seconds before an idle conn is recycled
 *
 * The Bun SQL constructor accepts these directly via its options object.
 * Falling back to safe defaults if the env vars are unparseable rather than
 * crashing the boot.
 */
function readPoolMax(): number {
  const raw = process.env.SHYNKRO_DB_POOL_MAX
  if (!raw) return 20
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn("SHYNKRO_DB_POOL_MAX is not a positive integer, falling back to 20", { raw })
    return 20
  }
  return parsed
}

function readIdleTimeoutSeconds(): number {
  const raw = process.env.SHYNKRO_DB_IDLE_TIMEOUT
  if (!raw) return 30
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn("SHYNKRO_DB_IDLE_TIMEOUT is not a non-negative integer, falling back to 30", { raw })
    return 30
  }
  return parsed
}

const poolMax = readPoolMax()
const idleTimeout = readIdleTimeoutSeconds()
logger.info("db pool configured", { max: poolMax, idleTimeoutSeconds: idleTimeout })

const client = new SQL({
  url: connectionString,
  max: poolMax,
  idleTimeout,
})
export const db = drizzle(client, { schema })
export type DB = typeof db

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname })
  logger.info("migrations applied")
}

export async function closeDb(): Promise<void> {
  await client.close()
  logger.info("database connection closed")
}
