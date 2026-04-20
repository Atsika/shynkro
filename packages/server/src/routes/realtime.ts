import Elysia from "elysia"
import { eq, and } from "drizzle-orm"
import { db } from "../db/index.js"
import { collaborativeDocs, workspaceMembers } from "../db/schema.js"
import { verifyJwt } from "../middleware/auth.js"
import {
  WsContext,
  unregisterClient,
  subscribeToWorkspace,
  subscribeToDoc,
  unsubscribeFromDoc,
  broadcastToWorkspace,
  broadcastToDoc,
  getWorkspacePresence,
  debouncedPresenceBroadcast,
  recordImmediatePresenceBroadcast,
  findOwner,
} from "../services/realtimeState.js"
import {
  encodeDocState,
  persistUpdate,
  maybeCompact,
  DocCorruptedError,
  DocDeletedError,
} from "../services/yjsService.js"
import {
  PROTOCOL_VERSION,
  WS_BINARY_YJS_UPDATE,
  WS_BINARY_YJS_STATE,
  WS_BINARY_AWARENESS,
  type ClientMessage,
} from "@shynkro/shared"
import { getUserById } from "../services/authService.js"
import { logger } from "../lib/logger.js"
import { envInt } from "../lib/envInt.js"

const TOKEN_EXPIRY_WARNING_SECS = 60

/** Max binary WS frame size (default 50 MB). Configurable via SHYNKRO_WS_MAX_FRAME. */
const WS_MAX_FRAME_BYTES = envInt("SHYNKRO_WS_MAX_FRAME", 50 * 1024 * 1024)

// Map from ws to context (Elysia ws lacks generic data on ServerWebSocket)
const ctxMap = new Map<object, WsContext>()

/**
 * Per-WS message processing chain. Bun's WS handler fires `message` async and
 * does not serialize them, so two messages can race — e.g. `subscribeDoc`
 * reaches the in-memory `ctx.subscribedWorkspaces.has(...)` check before the
 * preceding `subscribeWorkspace`'s DB query has resolved and called
 * `subscribeToWorkspace`. We chain each message's processing on the previous
 * one so a single connection's messages stay ordered without serializing
 * across connections.
 */
const procChain = new WeakMap<object, Promise<void>>()

export const realtimeRoutes = new Elysia().ws("/api/v1/realtime", {
  // --- open ---
  open(_ws) {
    // Context will be populated after hello message
  },

  // --- message ---
  async message(ws, rawMessage) {
    const prev = procChain.get(ws.raw) ?? Promise.resolve()
    const next = prev.then(() => processMessage(ws, rawMessage)).catch((err) => {
      logger.error("ws processMessage error", { err: String(err) })
    })
    procChain.set(ws.raw, next)
    await next
  },

  // --- close ---
  close(ws) {
    procChain.delete(ws.raw)
    const ctx = ctxMap.get(ws.raw)
    if (ctx) {
      for (const timer of ctx.awarenessTimeouts.values()) clearTimeout(timer)
      ctx.awarenessTimeouts.clear()
      if (ctx.expiryWarningTimer) clearTimeout(ctx.expiryWarningTimer)
      if (ctx.expiryCloseTimer) clearTimeout(ctx.expiryCloseTimer)
      const workspaces = [...ctx.subscribedWorkspaces]
      unregisterClient(ctx)
      for (const workspaceId of workspaces) {
        broadcastToWorkspace(workspaceId, {
          type: "presenceUpdate",
          workspaceId,
          users: getWorkspacePresence(workspaceId),
        })
        recordImmediatePresenceBroadcast(workspaceId)
        debouncedPresenceBroadcast(workspaceId)
      }
      ctxMap.delete(ws.raw)
    }
  },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processMessage(ws: any, rawMessage: unknown): Promise<void> {
    const ctx = ctxMap.get(ws.raw)

    // Handle binary frames (Yjs updates)
    if (rawMessage instanceof Buffer || rawMessage instanceof Uint8Array) {
      const buf = rawMessage instanceof Buffer ? rawMessage : Buffer.from(rawMessage)
      if (!ctx) { ws.close(4003, "Not authenticated"); return }

      // Viewers may not push Yjs updates
      if (ctx.role === "viewer") return

      // Hard frame-size cap. A frame that exceeds the configured maximum is
      // refused: we send a one-shot error JSON (so the client knows the env
      // var to bump) then close the WS with 1009 Message Too Big. Returning
      // without persisting prevents an OOM-shaped runaway from slipping by.
      if (buf.length > WS_MAX_FRAME_BYTES) {
        ws.send(JSON.stringify({
          type: "error",
          code: "FRAME_TOO_LARGE",
          message: `WS frame ${buf.length} bytes exceeds SHYNKRO_WS_MAX_FRAME=${WS_MAX_FRAME_BYTES}. Increase the env var on the server or split the operation into smaller pieces.`,
        }))
        logger.warn("ws frame exceeds size cap", { size: buf.length, cap: WS_MAX_FRAME_BYTES, userId: ctx.userId })
        ws.close(1009, "Frame too large")
        return
      }

      if (buf.length < 18) return // minimum: 1 byte type + 16 bytes docId + 1 byte data

      const frameType = buf[0]
      if (frameType === WS_BINARY_YJS_UPDATE) {
        // V2 layout: [type(1)][docId(16)][clientUpdateId(16)][update(N)].
        // The clientUpdateId is sender-private — echoed back in yjsUpdateAck
        // once persistUpdate() commits, then stripped before rebroadcast so
        // peers never see another client's ack correlation key.
        if (buf.length < 34) return
        const dh = buf.slice(1, 17).toString("hex")
        const docId = `${dh.slice(0,8)}-${dh.slice(8,12)}-${dh.slice(12,16)}-${dh.slice(16,20)}-${dh.slice(20)}`
        const ch = buf.slice(17, 33).toString("hex")
        const clientUpdateId = `${ch.slice(0,8)}-${ch.slice(8,12)}-${ch.slice(12,16)}-${ch.slice(16,20)}-${ch.slice(20)}`
        const update = buf.slice(33)

        // Persist BEFORE broadcasting — if persist fails, don't broadcast a phantom update
        try {
          await persistUpdate(docId, update)
        } catch (err) {
          if (err instanceof DocCorruptedError) {
            // Tell the client their edit was refused. Don't broadcast — everyone else
            // would get a phantom update that wasn't persisted.
            ws.send(JSON.stringify({
              type: "error",
              code: "DOC_CORRUPTED",
              message: err.message,
            }))
            return
          }
          if (err instanceof DocDeletedError) {
            // A late-arriving update for a file that was just deleted. Refuse the
            // write (otherwise it could silently un-delete the file) and tell the
            // client so they know to tear down their doc subscription.
            ws.send(JSON.stringify({
              type: "error",
              code: "DOC_DELETED",
              message: err.message,
            }))
            return
          }
          logger.error("persistUpdate failed", { docId, err: String(err) })
          return
        }

        // Durability confirmed. Echo the sender-private id so the client can
        // retire the row from its local unacked queue. A socket death right
        // after persist but before this send still lands in a safe state: the
        // client resends on reconnect and the server dedupes (Yjs CRDT makes
        // persistUpdate idempotent by clientID+clock).
        ws.send(JSON.stringify({ type: "yjsUpdateAck", docId, clientUpdateId }))

        // Rebroadcast the v1-shape frame (peers don't need the id).
        const peerFrame = Buffer.allocUnsafe(17 + update.length)
        buf.copy(peerFrame, 0, 0, 17)
        update.copy(peerFrame, 17)
        broadcastToDoc(docId, peerFrame, ctx)
        maybeCompact(docId).catch((err) => logger.error("compaction failed", { docId, err: String(err) }))
      }
      return
    }
    // Handle text frames (JSON)
    // Elysia may auto-parse JSON messages into objects already
    let msg: ClientMessage
    if (typeof rawMessage === "object" && rawMessage !== null) {
      msg = rawMessage as ClientMessage
    } else {
      try {
        msg = JSON.parse(rawMessage as string) as ClientMessage
      } catch {
        ws.send(JSON.stringify({ type: "error", code: "INVALID_JSON", message: "Invalid JSON" }))
        return
      }
    }

    // ---- hello ----
    if (msg.type === "hello") {
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "PROTOCOL_MISMATCH",
            message: `Expected protocol version ${PROTOCOL_VERSION}, got ${msg.protocolVersion}`,
          })
        )
        ws.close()
        return
      }

      const payload = await verifyJwt(msg.token)
      if (!payload) {
        ws.send(JSON.stringify({ type: "error", code: "AUTH_FAILED", message: "Invalid token" }))
        ws.close()
        return
      }

      const user = await getUserById(payload.sub)
      if (!user) {
        ws.send(JSON.stringify({ type: "error", code: "AUTH_FAILED", message: "User not found" }))
        ws.close()
        return
      }

      const newCtx: WsContext = {
        ws: ws.raw,
        userId: user.id,
        username: user.username,
        role: "viewer", // overwritten on subscribeWorkspace
        subscribedWorkspaces: new Set(),
        subscribedDocs: new Set(),
        jwtExp: payload.exp,
        awarenessTimeouts: new Map(),
        expiryWarningTimer: null,
        expiryCloseTimer: null,
      }
      ctxMap.set(ws.raw, newCtx)

      ws.send(JSON.stringify({ type: "welcome", userId: user.id, protocolVersion: PROTOCOL_VERSION }))

      // Schedule token expiry warning (S5: store handles so refreshToken can cancel)
      scheduleExpiryTimers(newCtx, ws, payload.exp)
      return
    }

    if (!ctx) {
      ws.send(JSON.stringify({ type: "error", code: "NOT_AUTHENTICATED", message: "Send hello first" }))
      return
    }

    // ---- refreshToken ----
    if (msg.type === "refreshToken") {
      const payload = await verifyJwt(msg.token)
      if (!payload) {
        ws.send(JSON.stringify({ type: "error", code: "AUTH_FAILED", message: "Invalid token" }))
        ws.close(4001, "Auth expired")
        return
      }
      ctx.jwtExp = payload.exp
      // S5: Cancel old expiry timers and reschedule with the new token's expiry
      if (ctx.expiryWarningTimer) { clearTimeout(ctx.expiryWarningTimer); ctx.expiryWarningTimer = null }
      if (ctx.expiryCloseTimer) { clearTimeout(ctx.expiryCloseTimer); ctx.expiryCloseTimer = null }
      scheduleExpiryTimers(ctx, ws, payload.exp)
      return
    }

    // ---- ping ----
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }))
      return
    }

    // ---- subscribeWorkspace ----
    if (msg.type === "subscribeWorkspace") {
      const [member] = await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, msg.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          )
        )
        .limit(1)

      if (!member) {
        ws.send(JSON.stringify({ type: "error", code: "FORBIDDEN", message: "Not a workspace member" }))
        return
      }

      ctx.role = member.role as "owner" | "editor" | "viewer"
      subscribeToWorkspace(ctx, msg.workspaceId)

      // Immediate broadcast — gives instant feedback to the subscribing client
      const presence = getWorkspacePresence(msg.workspaceId)
      logger.debug("subscribeWorkspace presence broadcast", {
        workspaceId: msg.workspaceId,
        userId: ctx.userId,
        userCount: presence.length,
        users: presence.map((u) => u.username),
      })
      broadcastToWorkspace(msg.workspaceId, {
        type: "presenceUpdate",
        workspaceId: msg.workspaceId,
        users: presence,
      })
      recordImmediatePresenceBroadcast(msg.workspaceId)
      // Deferred follow-up catches concurrent subscriptions (e.g. two clients
      // reconnecting after a window reload at the same time — each async handler
      // yields at the DB query and neither sees the other's subscription yet).
      // Skipped as a no-op if presence hasn't changed in the meantime.
      debouncedPresenceBroadcast(msg.workspaceId)
      return
    }

    // ---- subscribeDoc ----
    if (msg.type === "subscribeDoc") {
      // Membership already verified by subscribeWorkspace — use in-memory check
      if (!ctx.subscribedWorkspaces.has(msg.workspaceId)) {
        ws.send(JSON.stringify({ type: "error", code: "FORBIDDEN", message: "Not subscribed to workspace" }))
        return
      }

      // Verify doc belongs to the workspace
      const [docEntry] = await db
        .select({ id: collaborativeDocs.id })
        .from(collaborativeDocs)
        .where(
          and(
            eq(collaborativeDocs.id, msg.docId),
            eq(collaborativeDocs.workspaceId, msg.workspaceId)
          )
        )
        .limit(1)

      if (!docEntry) {
        ws.send(JSON.stringify({ type: "error", code: "FORBIDDEN", message: "Doc not found in workspace" }))
        return
      }

      // S2: Subscribe AFTER confirming the doc state loads successfully —
      // prevents adding client to docClients for deleted/corrupted docs.
      try {
        const state = await encodeDocState(msg.docId)
        subscribeToDoc(ctx, msg.docId)
        ws.send(JSON.stringify({ type: "docSubscribed", docId: msg.docId }))
        const h = msg.docId.replace(/-/g, "")
        const docIdBytes = Buffer.from(h, "hex")
        const frame = new Uint8Array(1 + 16 + state.length)
        frame[0] = WS_BINARY_YJS_STATE
        frame.set(docIdBytes, 1)
        frame.set(state, 17)
        logger.debug("sending state frame", { docId: msg.docId, size: frame.length })
        ws.raw.send(frame)
      } catch (err) {
        if (err instanceof DocCorruptedError) {
          ws.send(JSON.stringify({
            type: "error",
            code: "DOC_CORRUPTED",
            message: err.message,
          }))
        } else if (err instanceof DocDeletedError) {
          ws.send(JSON.stringify({
            type: "error",
            code: "DOC_DELETED",
            message: err.message,
          }))
        } else {
          logger.error("failed to send doc state", { docId: msg.docId, err: String(err) })
        }
      }
      return
    }

    // ---- unsubscribeDoc ----
    if (msg.type === "unsubscribeDoc") {
      unsubscribeFromDoc(ctx, msg.docId)
      const timer = ctx.awarenessTimeouts.get(msg.docId)
      if (timer) { clearTimeout(timer); ctx.awarenessTimeouts.delete(msg.docId) }
      return
    }

    // ---- requestPermission ----
    if (msg.type === "requestPermission") {
      const ownerCtx = findOwner(msg.workspaceId)
      if (ownerCtx) {
        ownerCtx.ws.send(JSON.stringify({
          type: "permissionRequested",
          workspaceId: msg.workspaceId,
          requesterId: ctx.userId,
          requesterName: ctx.username,
        }))
      }
      return
    }

    // ---- awarenessUpdate ----
    if (msg.type === "awarenessUpdate") {
      if (!ctx.subscribedDocs.has(msg.docId)) return  // must be subscribed to relay
      // S3: Viewers should not broadcast cursor/selection awareness
      if (ctx.role === "viewer") return
      // S3: Cap awareness payload size to prevent amplification (cursor payloads are small)
      if (msg.data.length > 4096) return
      const data = Buffer.from(msg.data, "base64")
      const docIdBytes = Buffer.from(msg.docId.replace(/-/g, ""), "hex")
      const frame = new Uint8Array(1 + 16 + data.length)
      frame[0] = WS_BINARY_AWARENESS
      frame.set(docIdBytes, 1)
      frame.set(data, 17)
      broadcastToDoc(msg.docId, frame, ctx)

      // Reset 30s TTL — on expiry broadcast empty awareness to clear ghost cursors
      const existing = ctx.awarenessTimeouts.get(msg.docId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        ctx.awarenessTimeouts.delete(msg.docId)
        const emptyPayload = Buffer.from(
          JSON.stringify({ userId: ctx.userId, username: ctx.username, cursor: null, selection: null }),
          "utf-8"
        )
        const emptyFrame = new Uint8Array(1 + 16 + emptyPayload.length)
        emptyFrame[0] = WS_BINARY_AWARENESS
        emptyFrame.set(docIdBytes, 1)
        emptyFrame.set(emptyPayload, 17)
        broadcastToDoc(msg.docId, emptyFrame)
      }, 30_000)
      ctx.awarenessTimeouts.set(msg.docId, timer)
      return
    }
}

/** S5: Schedule JWT expiry warning + auto-close timers. Stores handles on ctx for cancellation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scheduleExpiryTimers(ctx: WsContext, ws: any, exp: number): void {
  const msUntilExpiry = exp * 1000 - Date.now()
  if (msUntilExpiry <= 0) {
    ws.close(4001, "Auth expired")
    return
  }
  const warnAt = msUntilExpiry - TOKEN_EXPIRY_WARNING_SECS * 1000
  if (warnAt > 0) {
    ctx.expiryWarningTimer = setTimeout(() => {
      ctx.expiryWarningTimer = null
      if (ctxMap.has(ws.raw)) {
        ws.send(JSON.stringify({ type: "tokenExpiring", expiresIn: TOKEN_EXPIRY_WARNING_SECS }))
      }
    }, warnAt)
  } else if (ctxMap.has(ws.raw)) {
    ws.send(JSON.stringify({ type: "tokenExpiring", expiresIn: Math.max(1, Math.floor(msUntilExpiry / 1000)) }))
  }
  ctx.expiryCloseTimer = setTimeout(() => {
    ctx.expiryCloseTimer = null
    if (ctxMap.has(ws.raw)) {
      ws.close(4001, "Auth expired")
    }
  }, msUntilExpiry)
}
