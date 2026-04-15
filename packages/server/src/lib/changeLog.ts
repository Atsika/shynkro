import { db } from "../db/index.js"
import { workspaceChanges, type ChangeType } from "../db/schema.js"

export interface ChangeEntry {
  workspaceId: string
  revision: number
  type: ChangeType
  fileId?: string
  path?: string
  oldPath?: string
  kind?: string
  hash?: string
  size?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = { insert: (table: any) => { values: (v: any) => Promise<unknown> } }

export async function recordChange(entry: ChangeEntry, dbOrTx: DbLike = db as unknown as DbLike): Promise<void> {
  await dbOrTx.insert(workspaceChanges).values({
    workspaceId: entry.workspaceId,
    revision: entry.revision,
    type: entry.type,
    fileId: entry.fileId ?? null,
    path: entry.path ?? null,
    oldPath: entry.oldPath ?? null,
    kind: entry.kind ?? null,
    hash: entry.hash ?? null,
    size: entry.size ?? null,
  })
}
