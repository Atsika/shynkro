import { eq, and } from "drizzle-orm"
import { db } from "../db/index.js"
import { workspaceMembers } from "../db/schema.js"

export async function requireMember(workspaceId: string, userId: string) {
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1)
  return member ?? null
}
