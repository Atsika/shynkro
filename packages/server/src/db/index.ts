import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import * as schema from "./schema.js"
import { logger } from "../lib/logger.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is not set")

const client = new SQL(connectionString)
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
