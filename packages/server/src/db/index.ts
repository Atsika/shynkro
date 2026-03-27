import { drizzle } from "drizzle-orm/bun-sql"
import * as schema from "./schema.js"

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is not set")

export const db = drizzle(connectionString, { schema })
export type DB = typeof db
