import Elysia from "elysia"
import { eq, and } from "drizzle-orm"
import { db } from "../db/index.js"
import { collaborativeDocs, workspaceMembers } from "../db/schema.js"
import { verifyJwt } from "../middleware/auth.js"
import {
  WsContext,
  registerClient,
  unregisterClient,
  subscribeToWorkspace,
  subscribeToDoc,
  unsubscribeFromDoc,
  broadcastToWorkspace,
  broadcastToDoc,
  getWorkspacePresence,
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

const TOKEN_EXPIRY_WARNING_SECS = 60

// Map from ws to context (Elysia ws lacks generic data on ServerWebSocket)
const ctxMap = new Map<object, WsContext>()

export const realtimeRoutes = new Elysia().ws("/api/v1/realtime", {
  // --- open ---
  open(_ws) {
    // Context will be populated after hello message
  },

  // --- message ---
  async message(ws, rawMessage) {
    const ctx = ctxMap.get(ws.raw)

    // Handle binary frames (Yjs updates)
    if (rawMessage instanceof Buffer || rawMessage instanceof Uint8Array) {
      const buf = rawMessage instanceof Buffer ? rawMessage : Buffer.from(rawMessage)
      if (!ctx) { ws.close(4003, "Not authenticated"); return }

      // Viewers may not push Yjs updates
      if (ctx.role === "viewer") return

      if (buf.length < 18) return // minimum: 1 byte type + 16 bytes docId + 1 byte data

      const frameType = buf[0]
      if (frameType === WS_BINARY_YJS_UPDATE) {
        const h = buf.slice(1, 17).toString("hex")
        const docId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
        const update = buf.slice(17)

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
        broadcastToDoc(docId, buf, ctx)
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
      }
      ctxMap.set(ws.raw, newCtx)
      registerClient(newCtx)

      ws.send(JSON.stringify({ type: "welcome", userId: user.id, protocolVersion: PROTOCOL_VERSION }))

      // Schedule token expiry warning
      const msUntilExpiry = payload.exp * 1000 - Date.now()
      const warnAt = msUntilExpiry - TOKEN_EXPIRY_WARNING_SECS * 1000
      if (warnAt > 0) {
        setTimeout(() => {
          if (ctxMap.has(ws.raw)) {
            ws.send(JSON.stringify({ type: "tokenExpiring", expiresIn: TOKEN_EXPIRY_WARNING_SECS }))
          }
        }, warnAt)
        // Close if not refreshed
        setTimeout(() => {
          if (ctxMap.has(ws.raw)) {
            ws.close(4001, "Auth expired")
          }
        }, msUntilExpiry)
      }
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

      // Broadcast updated presence to workspace
      broadcastToWorkspace(msg.workspaceId, {
        type: "presenceUpdate",
        workspaceId: msg.workspaceId,
        users: getWorkspacePresence(msg.workspaceId),
      })
      return
    }

    // ---- subscribeDoc ----
    if (msg.type === "subscribeDoc") {
      // Verify workspace membership
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

      subscribeToDoc(ctx, msg.docId)
      ws.send(JSON.stringify({ type: "docSubscribed", docId: msg.docId }))

      // Send full Yjs state (use raw WS for binary — Elysia's wrapper may serialize)
      try {
        const state = await encodeDocState(msg.docId)
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
          // Surface the corruption clearly instead of silently serving no state —
          // which would look identical to a fresh empty doc to the client.
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
  },

  // --- close ---
  close(ws) {
    const ctx = ctxMap.get(ws.raw)
    if (ctx) {
      // Clear all awareness TTL timers
      for (const timer of ctx.awarenessTimeouts.values()) clearTimeout(timer)
      ctx.awarenessTimeouts.clear()

      // Snapshot workspace list before unregistering (unregister clears the sets)
      const workspaces = [...ctx.subscribedWorkspaces]
      unregisterClient(ctx)
      // Broadcast departure presence update to all subscribed workspaces
      for (const workspaceId of workspaces) {
        broadcastToWorkspace(workspaceId, {
          type: "presenceUpdate",
          workspaceId,
          users: getWorkspacePresence(workspaceId),
        })
      }
      ctxMap.delete(ws.raw)
    }
  },
})
