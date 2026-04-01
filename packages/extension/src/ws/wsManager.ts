import * as vscode from "vscode"
// Node 22+ has global WebSocket (stable)
import { PROTOCOL_VERSION } from "@shynkro/shared"
import type { ClientMessage, ServerMessage, WorkspaceId } from "@shynkro/shared"
import {
  EXTENSION_VERSION,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
} from "../constants"
import type { AuthService } from "../auth/authService"
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
  private pendingBinaryFrames: Uint8Array[] = []

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
    private readonly statusBar: StatusBar
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
    this._onStatusChange.fire("connecting")
    this.statusBar.setStatus("connecting")

    const token = await this.authService.getValidAccessToken(this.serverUrl).catch(() => undefined)
    if (!token) {
      this.scheduleReconnect()
      return
    }

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
          const msg = JSON.parse(event.data as string) as ServerMessage
          this.handleServerMessage(msg)
        } catch (err) {
          log.appendLine(`[ws] Failed to parse server message: ${err}`)
        }
      }
    })

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return // stale connection — ignore
      this.clearTimers()
      if (this.disposed) return
      this._onStatusChange.fire("disconnected")
      this.statusBar.setStatus("disconnected")
      this.scheduleReconnect()
    })

    ws.addEventListener("error", () => {
      log.appendLine(`[ws] connection error`)
    })
  }

  private handleServerMessage(msg: ServerMessage): void {
    if (msg.type === "welcome") {
      this.userId = msg.userId
      this.sendJson({ type: "subscribeWorkspace", workspaceId: this.workspaceId })
      this._onStatusChange.fire("connected")
      this.statusBar.setStatus("connected")
      this.startPing()
      // Flush any Yjs updates that were buffered while disconnected/connecting
      if (this.pendingBinaryFrames.length > 0) {
        const frames = this.pendingBinaryFrames.splice(0)
        for (const frame of frames) this.sendBinary(frame)
      }
    } else if (msg.type === "pong") {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
    } else if (msg.type === "tokenExpiring") {
      this.authService.getValidAccessToken(this.serverUrl).then((t) => {
        if (t) this.sendJson({ type: "refreshToken", token: t })
      }).catch(() => {})
    } else if (msg.type === "error") {
      vscode.window.showErrorMessage(`Shynkro WS error: ${msg.message}`)
    }
    this._onServerMessage.fire(msg)
  }

  private handleBinary(buf: Buffer): void {
    if (buf.length < 17) return
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

  sendBinary(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame)
    } else {
      // Buffer Yjs updates while disconnected/connecting — flushed on welcome
      this.pendingBinaryFrames.push(frame)
    }
  }

  private startPing(): void {
    this.clearTimers()
    this.pingTimer = setInterval(() => {
      this.sendJson({ type: "ping" })
      this.pongTimer = setTimeout(() => {
        log.appendLine("[ws] pong timeout — terminating connection")
        this.ws?.close()
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  private scheduleReconnect(): void {
    // Clear any existing reconnect timer to prevent stacking
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    const jitter = Math.random() * 500
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS) + jitter
    this.reconnectAttempt++
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

  dispose(): void {
    this.disposed = true
    this.disconnect()
    this._onServerMessage.dispose()
    this._onBinaryFrame.dispose()
    this._onStatusChange.dispose()
  }
}
