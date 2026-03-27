import { db } from "../src/db/index.ts"
import { sql } from "drizzle-orm"

await db.execute(sql`TRUNCATE yjs_updates, collaborative_docs, import_files, import_sessions, file_entries, workspace_members, workspaces, refresh_tokens, users RESTART IDENTITY CASCADE`)
console.log("DB cleared")
process.exit(0)
