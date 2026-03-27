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
}

export interface SyncState {
  workspaceId: string
  revision: number
  lastSyncAt: string
}

export type ConnectionStatus = "idle" | "disconnected" | "connecting" | "connected" | "syncing"

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
