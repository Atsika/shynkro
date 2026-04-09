import type { Role, ServerMessage } from "@shynkro/shared"

export interface WsContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws: any
  userId: string
  username: string
  role: Role
  subscribedWorkspaces: Set<string>
  subscribedDocs: Set<string>
  jwtExp: number // Unix timestamp
  awarenessTimeouts: Map<string, ReturnType<typeof setTimeout>>
}

// In-memory state for single-instance MVP
const workspaceClients = new Map<string, Set<WsContext>>()
const docClients = new Map<string, Set<WsContext>>()

export function registerClient(_ctx: WsContext): void {
  // Placeholder — subscriptions are registered individually via subscribeToWorkspace/subscribeToDoc
}

export function unregisterClient(ctx: WsContext): void {
  for (const workspaceId of ctx.subscribedWorkspaces) {
    workspaceClients.get(workspaceId)?.delete(ctx)
    if (workspaceClients.get(workspaceId)?.size === 0) {
      workspaceClients.delete(workspaceId)
    }
  }
  for (const docId of ctx.subscribedDocs) {
    docClients.get(docId)?.delete(ctx)
    if (docClients.get(docId)?.size === 0) {
      docClients.delete(docId)
    }
  }
}

export function subscribeToWorkspace(ctx: WsContext, workspaceId: string): void {
  ctx.subscribedWorkspaces.add(workspaceId)
  if (!workspaceClients.has(workspaceId)) workspaceClients.set(workspaceId, new Set())
  workspaceClients.get(workspaceId)!.add(ctx)
}

export function subscribeToDoc(ctx: WsContext, docId: string): void {
  ctx.subscribedDocs.add(docId)
  if (!docClients.has(docId)) docClients.set(docId, new Set())
  docClients.get(docId)!.add(ctx)
}

export function unsubscribeFromDoc(ctx: WsContext, docId: string): void {
  ctx.subscribedDocs.delete(docId)
  docClients.get(docId)?.delete(ctx)
}

export function broadcastToWorkspace(
  workspaceId: string,
  message: ServerMessage,
  exclude?: WsContext
): void {
  const clients = workspaceClients.get(workspaceId)
  if (!clients) return
  const payload = JSON.stringify(message)
  for (const ctx of clients) {
    if (ctx !== exclude) {
      ctx.ws.send(payload)
    }
  }
}

export function broadcastToDoc(
  docId: string,
  data: string | Uint8Array,
  exclude?: WsContext
): void {
  const clients = docClients.get(docId)
  if (!clients) return
  for (const ctx of clients) {
    if (ctx !== exclude) {
      ctx.ws.send(data)
    }
  }
}

export function getWorkspacePresence(workspaceId: string) {
  const clients = workspaceClients.get(workspaceId) ?? new Set<WsContext>()
  return [...clients].map((c) => ({ userId: c.userId, username: c.username, role: c.role }))
}

export function updateClientRole(workspaceId: string, userId: string, newRole: Role): void {
  const clients = workspaceClients.get(workspaceId)
  if (!clients) return
  for (const ctx of clients) {
    if (ctx.userId === userId) ctx.role = newRole
  }
}

export function findOwner(workspaceId: string): WsContext | undefined {
  const clients = workspaceClients.get(workspaceId)
  return clients ? [...clients].find((c) => c.role === "owner") : undefined
}

export function sendToUser(workspaceId: string, userId: string, message: ServerMessage): void {
  const clients = workspaceClients.get(workspaceId)
  if (!clients) return
  const payload = JSON.stringify(message)
  for (const ctx of clients) {
    if (ctx.userId === userId) ctx.ws.send(payload)
  }
}

export function closeAllConnections(): void {
  const seen = new Set<WsContext>()
  for (const clients of workspaceClients.values()) {
    for (const ctx of clients) {
      if (seen.has(ctx)) continue
      seen.add(ctx)
      try { ctx.ws.close(1001, "Server shutting down") } catch {}
    }
  }
  workspaceClients.clear()
  docClients.clear()
}

/**
 * Total number of distinct WS clients currently subscribed to any workspace.
 * Used by the graceful-shutdown drain to wait until all clients disconnect
 * before force-closing.
 */
export function countActiveConnections(): number {
  const seen = new Set<WsContext>()
  for (const clients of workspaceClients.values()) {
    for (const ctx of clients) seen.add(ctx)
  }
  return seen.size
}

/**
 * Send a `serverShutdown` JSON frame to every connected client. Triggers the
 * extension's pre-shutdown drain logic (flush pending op queue, dump anything
 * unsent to .shynkro/recovery/, etc.) before the server force-closes the WS.
 *
 * Idempotent — safe to call multiple times. Failures per-client are logged
 * but don't abort the broadcast.
 */
export function notifyAllShuttingDown(): void {
  const payload = JSON.stringify({ type: "serverShutdown" })
  const seen = new Set<WsContext>()
  for (const clients of workspaceClients.values()) {
    for (const ctx of clients) {
      if (seen.has(ctx)) continue
      seen.add(ctx)
      try { ctx.ws.send(payload) } catch { /* client already gone */ }
    }
  }
}
