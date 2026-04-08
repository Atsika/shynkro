/**
 * Idempotency cache for mutating REST ops.
 *
 * The problem this solves: an extension that crashes between "server applied
 * my create" and "server's response reached me" replays its pending_ops queue
 * on restart. Without deduplication, that replay creates a duplicate file or
 * surfaces a spurious 409. With deduplication, the server recognizes the same
 * `op_id` and returns the original response unchanged.
 *
 * The client passes a UUID in the `X-Shynkro-Op-Id` header when replaying from
 * pending_ops (see packages/extension/src/sync/opQueue.ts). Direct online ops
 * don't set the header — they aren't persisted and therefore can't replay.
 *
 * Integration pattern in route handlers:
 *
 *     const opId = getOpIdHeader(headers)
 *     if (opId) {
 *       const cached = await readIdempotencyCache(workspaceId, opId)
 *       if (cached) return status(cached.status, cached.body)
 *     }
 *     // ...normal handler work, including early-return 4xx for validation...
 *     const response = { ... }
 *     if (opId) await writeIdempotencyCache(workspaceId, opId, 200, response)
 *     return response
 */

import { and, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { recentOpIds } from "../db/schema.js"
import { logger } from "./logger.js"

/** HTTP header carrying the client-generated UUID. Lowercased for Elysia. */
export const OP_ID_HEADER = "x-shynkro-op-id"

export interface IdempotentResult {
  status: number
  body: unknown
}

/**
 * Look up a previously-cached response for this (workspace, op) pair. Returns
 * null when there is no cached entry or the cached row is unreadable.
 */
export async function readIdempotencyCache(
  workspaceId: string,
  opId: string
): Promise<IdempotentResult | null> {
  const [row] = await db
    .select({ result: recentOpIds.result })
    .from(recentOpIds)
    .where(and(eq(recentOpIds.workspaceId, workspaceId), eq(recentOpIds.opId, opId)))
    .limit(1)
  if (!row) return null
  try {
    return JSON.parse(row.result) as IdempotentResult
  } catch (err) {
    logger.error("corrupt recent_op_ids row — ignoring", { workspaceId, opId, err: String(err) })
    return null
  }
}

/**
 * Persist the response for this (workspace, op) pair. Uses ON CONFLICT DO NOTHING
 * so a racing duplicate request doesn't fail on the unique constraint — the first
 * row wins, the second is a no-op.
 *
 * Only successful responses are worth caching. Transient errors (403 auth, 400
 * validation) are deterministic-enough to re-run; caching them would prevent the
 * user from ever retrying after fixing the underlying issue.
 */
export async function writeIdempotencyCache(
  workspaceId: string,
  opId: string,
  status: number,
  body: unknown
): Promise<void> {
  try {
    await db
      .insert(recentOpIds)
      .values({ workspaceId, opId, result: JSON.stringify({ status, body }) })
      .onConflictDoNothing()
  } catch (err) {
    logger.error("failed to persist recent_op_ids row", { workspaceId, opId, err: String(err) })
  }
}

/** Read the op_id header from an Elysia/fetch headers object. */
export function getOpIdHeader(
  headers: Headers | Record<string, string | undefined>
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(OP_ID_HEADER) ?? undefined
  }
  // Elysia lowercases header names before passing them to handlers.
  return headers[OP_ID_HEADER] ?? undefined
}
