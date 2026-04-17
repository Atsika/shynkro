import type { WorkspaceId } from "@shynkro/shared"

export interface ProjectConfig {
  workspaceId: WorkspaceId
  serverUrl: string
  revision: number
}

export interface FileMapRow {
  fileId: string
  path: string
  kind: string
  docId: string | null
  binaryHash: string | null
  /**
   * V6: Last hash known to be in sync with the server. Diverges from
   * `binaryHash` while a local edit is pending upload — the binary conflict
   * picker uses the divergence to detect "both sides changed".
   */
  syncedBinaryHash: string | null
  /** "lf" | "crlf" — null if not yet sniffed (binary, folder, or pre-Unit-A row) */
  eolStyle: "lf" | "crlf" | null
  /** SQLite stores 0/1; truthy means the on-disk file starts with a UTF-8 BOM */
  hasBom: number
  /** POSIX mode bits & 0o777, or null on Windows / unknown */
  mode: number | null
}

export interface SyncState {
  workspaceId: string
  revision: number
  lastSyncAt: string
}

export type ConnectionStatus = "idle" | "disconnected" | "connecting" | "connected"

export interface ExtensionDeps {
  workspaceRoot: string
  config: ProjectConfig
  authService: import("./auth/authService").AuthService
  restClient: import("./api/restClient").RestClient
  stateDb: import("./state/stateDb").StateDb
  wsManager: import("./ws/wsManager").WsManager
  statusBar: import("./status/statusBar").StatusBar
  fileWatcher: import("./sync/fileWatcher").FileWatcher
  changeReconciler: import("./sync/changeReconciler").ChangeReconciler
  yjsBridge: import("./yjs/yjsBridge").YjsBridge
  binarySync: import("./binary/binarySync").BinarySync
}
