import type { DocId, FileId, FileKind, Role, UserId, WorkspaceId } from "./workspace.js"

export const PROTOCOL_VERSION = 2

// Binary frame type bytes
export const WS_BINARY_YJS_UPDATE = 0x01
export const WS_BINARY_YJS_STATE = 0x02
export const WS_BINARY_AWARENESS = 0x03

/**
 * Wire layouts (sender → server):
 *   YJS_UPDATE   : [type(1)][docId(16)][clientUpdateId(16)][update(N)]
 *   AWARENESS    : [type(1)][docId(16)][payload(N)]
 * Server → peers (rebroadcast):
 *   YJS_UPDATE   : [type(1)][docId(16)][update(N)]  — clientUpdateId stripped
 *   YJS_STATE    : [type(1)][docId(16)][state(N)]
 *   AWARENESS    : [type(1)][docId(16)][payload(N)]
 * The clientUpdateId is sender-private. After the server's persistUpdate()
 * commits, a JSON YjsUpdateAckMessage (docId + clientUpdateId) is sent back
 * to the sender so the row can be retired from its local unacked queue.
 */

// ---- Client → Server (text frames) ----

export interface HelloMessage {
  type: "hello"
  protocolVersion: number
  extensionVersion: string
  token: string
}

export interface RefreshTokenMessage {
  type: "refreshToken"
  token: string
}

export interface SubscribeWorkspaceMessage {
  type: "subscribeWorkspace"
  workspaceId: WorkspaceId
}

export interface SubscribeDocMessage {
  type: "subscribeDoc"
  workspaceId: WorkspaceId
  docId: DocId
}

export interface UnsubscribeDocMessage {
  type: "unsubscribeDoc"
  docId: DocId
}

export interface AwarenessUpdateMessage {
  type: "awarenessUpdate"
  docId: DocId
  data: string // base64-encoded Yjs awareness
}

export interface PingMessage {
  type: "ping"
}

export type ClientMessage =
  | HelloMessage
  | RefreshTokenMessage
  | SubscribeWorkspaceMessage
  | SubscribeDocMessage
  | UnsubscribeDocMessage
  | AwarenessUpdateMessage
  | RequestPermissionMessage
  | PingMessage

// ---- Server → Client (text frames) ----

export interface WelcomeMessage {
  type: "welcome"
  userId: UserId
  protocolVersion: number
}

export interface ErrorMessage {
  type: "error"
  code: string
  message: string
}

export interface TokenExpiringMessage {
  type: "tokenExpiring"
  expiresIn: number // seconds
}

export interface FileCreatedMessage {
  type: "fileCreated"
  workspaceId: WorkspaceId
  fileId: FileId
  path: string
  kind: FileKind
  docId?: DocId
  /** POSIX mode bits & 0o777 — propagated from the uploader to all peers. */
  mode?: number | null
  /**
   * Binary-file hash at create time, populated by `/changes` during offline
   * catch-up (since the underlying file entry already has a blob uploaded).
   * For the live WS broadcast path this is absent — the receiver waits for
   * the subsequent `binaryUpdated` event to trigger the download.
   */
  hash?: string
  revision: number
}

export interface FileRenamedMessage {
  type: "fileRenamed"
  workspaceId: WorkspaceId
  fileId: FileId
  path: string
  oldPath: string
  revision: number
}

export interface FileDeletedMessage {
  type: "fileDeleted"
  workspaceId: WorkspaceId
  fileId: FileId
  path: string
  revision: number
}

export interface BinaryUpdatedMessage {
  type: "binaryUpdated"
  workspaceId: WorkspaceId
  fileId: FileId
  hash: string
  size: number
  /** POSIX mode bits & 0o777 — propagated from the uploader to all peers. */
  mode?: number | null
  revision: number
}

export interface FileContentChangedMessage {
  type: "fileContentChanged"
  workspaceId: WorkspaceId
  fileId: FileId
  path: string
  revision: number
}

export interface PresenceUser {
  userId: UserId
  username: string
  role: Role
}

export interface PresenceUpdateMessage {
  type: "presenceUpdate"
  workspaceId: WorkspaceId
  users: PresenceUser[]
}

export interface PermissionChangedMessage {
  type: "permissionChanged"
  workspaceId: WorkspaceId
  userId: UserId  // whose role changed
  role: Role
}

export interface RequestPermissionMessage {
  type: "requestPermission"
  workspaceId: WorkspaceId
}

export interface PermissionRequestedMessage {
  type: "permissionRequested"
  workspaceId: WorkspaceId
  requesterId: UserId
  requesterName: string
}

export interface MemberRemovedMessage {
  type: "memberRemoved"
  workspaceId: WorkspaceId
  /** The user that was removed. Clients compare against their own userId. */
  userId: string
}

export interface WorkspaceDeletedMessage {
  type: "workspaceDeleted"
  workspaceId: WorkspaceId
}

export interface WorkspaceRenamedMessage {
  type: "workspaceRenamed"
  workspaceId: WorkspaceId
  name: string
}

export interface DocSubscribedMessage {
  type: "docSubscribed"
  docId: DocId
}

/**
 * Sent to every connected client at the start of a graceful server shutdown.
 * Clients should treat this as advance notice to flush any pending state
 * (drain the op queue, dump unsent ops to recovery, etc.) before the server
 * force-closes the WebSocket at the end of the drain window.
 */
export interface ServerShutdownMessage {
  type: "serverShutdown"
}

export interface DocResetMessage {
  type: "docReset"
  docId: DocId
}

/**
 * Sent by the server to the originating client after `persistUpdate(docId,
 * update)` commits successfully. The client uses `clientUpdateId` to mark the
 * corresponding row in its local unacked queue as durable. Without this ack,
 * socket death between `ws.send` and server-side commit would silently lose
 * the update.
 */
export interface YjsUpdateAckMessage {
  type: "yjsUpdateAck"
  docId: DocId
  clientUpdateId: string
}

export interface PongMessage {
  type: "pong"
}

// ---- Awareness payload (not a WS message — carried inside AwarenessUpdateMessage.data) ----

export interface CursorPayload {
  userId: string
  username: string
  /** Cursor position, or null to signal the cursor should be removed. */
  cursor: { line: number; character: number } | null
  /** Selection range, or null when the cursor has no active selection. */
  selection: {
    anchor: { line: number; character: number }
    active:  { line: number; character: number }
  } | null
}

export type ServerMessage =
  | WelcomeMessage
  | ErrorMessage
  | TokenExpiringMessage
  | FileCreatedMessage
  | FileRenamedMessage
  | FileDeletedMessage
  | BinaryUpdatedMessage
  | FileContentChangedMessage
  | PresenceUpdateMessage
  | PermissionChangedMessage
  | PermissionRequestedMessage
  | MemberRemovedMessage
  | WorkspaceDeletedMessage
  | WorkspaceRenamedMessage
  | DocSubscribedMessage
  | DocResetMessage
  | ServerShutdownMessage
  | YjsUpdateAckMessage
  | PongMessage
