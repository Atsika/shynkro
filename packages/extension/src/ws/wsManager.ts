import * as vscode from "vscode"
// Node 22+ has global WebSocket (stable)
import { PROTOCOL_VERSION, WS_BINARY_YJS_UPDATE } from "@shynkro/shared"
import type { ClientMessage, ServerMessage, WorkspaceId } from "@shynkro/shared"

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
function buildBinaryFrame(frameType: number, docId: string, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 16 + data.length)
  frame[0] = frameType
  frame.set(uuidToBytes(docId), 1)
  frame.set(data, 17)
  return frame
}
import {
  EXTENSION_VERSION,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
} from "../constants"
import type { AuthService } from "../auth/authService"
import type { StateDb } from "../state/stateDb"
import type { StatusBar } from "../status/statusBar"
import { log } from "../logger"

export interface BinaryFrame {
  frameType: number
  docId: string  // UUID with dashes
  data: Uint8Array
}

export class WsManager {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null
  private disposed = false
  private loggedOutNotified = false

  private serverUrl = ""
  private workspaceId: WorkspaceId = "" as WorkspaceId
  userId = ""

  private readonly _onServerMessage = new vscode.EventEmitter<ServerMessage>()
  readonly onServerMessage = this._onServerMessage.event

  private readonly _onBinaryFrame = new vscode.EventEmitter<BinaryFrame>()
  readonly onBinaryFrame = this._onBinaryFrame.event

  private readonly _onStatusChange = new vscode.EventEmitter<"disconnected" | "connecting" | "connected">()
  readonly onStatusChange = this._onStatusChange.event

  constructor(
    private readonly authService: AuthService,
    private readonly statusBar: StatusBar,
    /**
     * Optional: when set, Yjs binary frames that cannot be sent because the WS
     * is not open are persisted to stateDb instead of an in-memory queue. This
     * makes them survive extension reloads (Developer: Reload Window, crash,
     * VS Code restart) which previously dropped any offline edits silently.
     */
    private readonly stateDb?: StateDb
  ) {}

  connect(serverUrl: string, workspaceId: WorkspaceId): void {
    this.serverUrl = serverUrl
    this.workspaceId = workspaceId
    this.doConnect()
  }

  private async doConnect(): Promise<void> {
    if (this.disposed) return

    // Clean up any previous connection before creating a new one
    this.closeCurrentWs()

    const wsUrl = this.serverUrl.replace(/^http/, "ws") + "/api/v1/realtime"
    log.appendLine(`[ws] connecting (attempt ${this.reconnectAttempt + 1}) → ${wsUrl}`)
    this._onStatusChange.fire("connecting")
    this.statusBar.setStatus("connecting")

    const token = await this.authService.getValidAccessToken(this.serverUrl).catch(() => undefined)
    if (!token) {
      this._onStatusChange.fire("disconnected")
      this.statusBar.setStatus("disconnected")
      // getValidAccessToken returns undefined (no throw) only when there are no
      // stored credentials. In that case the user must log in — keep looping
      // would be pointless and the status bar would spin forever.
      const hasCredentials = await this.authService.hasCredentials(this.serverUrl)
      if (!hasCredentials) {
        log.appendLine("[ws] no credentials — stopping reconnect loop")
        if (!this.loggedOutNotified) {
          this.loggedOutNotified = true
          vscode.window.showWarningMessage(
            "Shynkro: session expired or not logged in. Please log in to resume syncing.",
            "Log In"
          ).then((choice) => { if (choice === "Log In") vscode.commands.executeCommand("shynkro.login") })
        }
        return // Do not schedule reconnect — startSync/connect() will restart when user logs in
      }
      // Server is temporarily unreachable (token refresh timed out) — keep retrying.
      this.scheduleReconnect()
      return
    }
    this.loggedOutNotified = false // Reset so future logged-out events notify again

    const ws = new WebSocket(wsUrl)
    ws.binaryType = "arraybuffer"
    this.ws = ws

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return // stale connection
      this.reconnectAttempt = 0
      this.sendJson({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: EXTENSION_VERSION,
        token,
      })
    })

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return // stale connection
      if (event.data instanceof ArrayBuffer) {
        this.handleBinary(Buffer.from(event.data))
      } else {
        try {
          const parsed = JSON.parse(event.data as string)
          // P3: Basic shape validation before casting — reject non-objects and missing type
          if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
            log.appendLine(`[ws] malformed server message — missing type field`)
            return
          }
          this.handleServerMessage(parsed as ServerMessage)
        } catch (err) {
          log.appendLine(`[ws] Failed to parse server message: ${err}`)
        }
      }
    })

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return // stale connection — ignore
      this.clearTimers()
      if (this.disposed) return
      const code = (event as { code?: number }).code ?? "?"
      log.appendLine(`[ws] closed (code=${code})`)
      this._onStatusChange.fire("disconnected")
      this.statusBar.setStatus("disconnected")
      this.scheduleReconnect()
    })

    ws.addEventListener("error", () => {
      log.appendLine(`[ws] connection error`)
      if (this.ws !== ws || this.disposed) return
      // Null this.ws before scheduling so that if Node.js also fires a close
      // event for the same socket (some versions do), the close handler sees a
      // stale connection and returns early — preventing a double scheduleReconnect
      // which would double-increment the backoff and make retries feel stuck.
      this.ws = null
      this.clearTimers()
      this._onStatusChange.fire("disconnected")
      this.statusBar.setStatus("disconnected")
      this.scheduleReconnect()
    })
  }

  private handleServerMessage(msg: ServerMessage): void {
    if (msg.type === "welcome") {
      this.userId = msg.userId
      this.sendJson({ type: "subscribeWorkspace", workspaceId: this.workspaceId })
      // Flush persisted offline Yjs frames BEFORE firing "connected".
      // "connected" causes yjsBridge to send subscribeDoc for each open editor,
      // which makes the server send back the current doc state. If we flushed
      // AFTER that, the server would send the pre-flush state and the client
      // would detect a spurious conflict even though the edits would CRDT-merge
      // cleanly. By flushing first, the WS send buffer order is:
      //   subscribeWorkspace → offline frames → subscribeDoc
      // so the server applies the offline edits before computing the state to send.
      if (this.stateDb) {
        // V6: flush all unacked local Yjs updates. Each row carries doc_id +
        // raw update bytes; rebuild the wire frame here so storage stays
        // origin-format-agnostic. Mark acked on successful send.
        const rows = this.stateDb.loadAllUnackedLocalUpdates()
        if (rows.length > 0) {
          log.appendLine(`[ws] flushing ${rows.length} persisted Yjs update(s) after reconnect`)
          for (const row of rows) {
            if (this.ws?.readyState !== WebSocket.OPEN) break
            try {
              const frame = buildBinaryFrame(WS_BINARY_YJS_UPDATE, row.docId, row.bytes)
              this.ws.send(frame)
              this.stateDb.markYjsUpdateAcked(row.id)
            } catch (err) {
              log.appendLine(`[ws] flush send error for update ${row.id}: ${err}`)
              break
            }
          }
        }
      }
      // H6: the socket can die mid-flush. If readyState is no longer OPEN,
      // skip the "connected" transition — the close handler will schedule a
      // reconnect and we'll try again.
      if (this.ws?.readyState !== WebSocket.OPEN) {
        log.appendLine("[ws] socket not OPEN after flush, deferring connected status")
        return
      }
      this._onStatusChange.fire("connected")
      this.statusBar.setStatus("connected")
      this.startPing()
    } else if (msg.type === "pong") {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
    } else if (msg.type === "tokenExpiring") {
      this.authService.getValidAccessToken(this.serverUrl).then((t) => {
        if (t) this.sendJson({ type: "refreshToken", token: t })
      }).catch((err) => log.appendLine(`[ws] tokenExpiring refresh failed: ${err}`))
    } else if (msg.type === "error") {
      // Suppress transient protocol errors that are not actionable by the user.
      // FORBIDDEN/NOT_AUTHENTICATED/DOC_DELETED are handled by higher-level code;
      // surface only errors that require the user to take action.
      const suppress = new Set(["FORBIDDEN", "NOT_AUTHENTICATED", "DOC_DELETED", "DOC_CORRUPTED"])
      if (!suppress.has((msg as { code?: string }).code ?? "")) {
        vscode.window.showErrorMessage(`Shynkro WS error: ${msg.message}`)
      } else {
        log.appendLine(`[ws] server error (suppressed): ${(msg as { code?: string }).code} — ${msg.message}`)
      }
    }
    this._onServerMessage.fire(msg)
  }

  private handleBinary(buf: Buffer): void {
    // P1: Match server's minimum of 18 bytes (1 type + 16 docId + 1 data)
    if (buf.length < 18) return
    const frameType = buf[0]
    const h = buf.slice(1, 17).toString("hex")
    const docId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
    const data = new Uint8Array(buf.slice(17))
    this._onBinaryFrame.fire({ frameType, docId, data })
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  sendJson(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  /**
   * Send a binary WS frame. Returns true if the WS accepted it for delivery,
   * false if the socket was not open (caller's responsibility to persist via
   * `stateDb.appendYjsUpdate(..., acked: false)` and let the reconnect flush
   * replay it).
   */
  sendBinary(frame: Uint8Array): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame)
      return true
    }
    return false
  }

  private startPing(): void {
    this.clearTimers()
    this.pingTimer = setInterval(() => {
      this.sendJson({ type: "ping" })
      // P2: Only start a pong timer if one isn't already running — prevents
      // ghost timers from accumulating if pong is slow.
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          this.pongTimer = null
          log.appendLine("[ws] pong timeout — terminating connection")
          this.ws?.close()
        }, PONG_TIMEOUT_MS)
      }
    }, PING_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    // Clear any existing reconnect timer to prevent stacking
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    const jitter = Math.random() * 500
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS) + jitter
    this.reconnectAttempt++
    log.appendLine(`[ws] reconnect in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt})`)
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay)
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null }
  }

  /** Close the current WS without triggering reconnect. */
  private closeCurrentWs(): void {
    this.clearTimers()
    if (this.ws) {
      const old = this.ws
      this.ws = null // detach first so the close handler is a no-op (this.ws !== ws)
      old.close()
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.closeCurrentWs()
  }

  /**
   * Close the current WS connection without preventing the close handler from
   * scheduling a reconnect. Used when the server signals graceful shutdown:
   * we close our end cleanly (so the server drain sees the count drop) while
   * the reconnect loop stays active and picks up the server when it restarts.
   */
  closeForReconnect(): void {
    this.clearTimers()
    if (this.ws) this.ws.close()
    // Deliberately do NOT null this.ws — the close event fires normally and
    // scheduleReconnect() is called by the existing close handler.
  }

  dispose(): void {
    this.disposed = true
    this.disconnect()
    this._onServerMessage.dispose()
    this._onBinaryFrame.dispose()
    this._onStatusChange.dispose()
  }
}
