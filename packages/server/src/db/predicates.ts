import { and, eq } from "drizzle-orm"
import { fileEntries, workspaces } from "./schema.js"

/**
 * Reusable WHERE predicates. Thin helpers that factor the "not deleted" guard
 * so routes don't spell out the same AND/eq chain in a dozen places. They
 * compose with drizzle's query builder — callers still supply their own
 * projection, order, limit, etc.
 */

/** File by id, excluding soft-deleted rows. */
export const activeFileById = (fileId: string) =>
  and(eq(fileEntries.id, fileId), eq(fileEntries.deleted, false))

/** All non-deleted files in a workspace. */
export const activeFilesInWorkspace = (workspaceId: string) =>
  and(eq(fileEntries.workspaceId, workspaceId), eq(fileEntries.deleted, false))

/** Active (not soft-deleted) workspace by id. */
export const activeWorkspaceById = (workspaceId: string) =>
  and(eq(workspaces.id, workspaceId), eq(workspaces.status, "active"))
