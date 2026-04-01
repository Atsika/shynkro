import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import * as schema from "./schema.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is not set")

export const db = drizzle(connectionString, { schema })
export type DB = typeof db

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: new URL("./migrations", import.meta.url).pathname })
  console.log("[db] migrations applied")
}
