export type WorkspaceId = string
export type FileId = string
export type DocId = string
export type UserId = string
export type ImportSessionId = string

export type Role = "owner" | "editor" | "viewer"
export type FileKind = "text" | "binary" | "folder"
export type WorkspaceStatus = "active" | "archived" | "deleted"
export type ImportSessionStatus = "in_progress" | "committed" | "aborted" | "expired"

export interface UserInfo {
  id: UserId
  username: string
  createdAt: string
}

export interface WorkspaceInfo {
  id: WorkspaceId
  name: string
  ownerId: UserId
  revision: number
  status: WorkspaceStatus
  createdAt: string
  updatedAt: string
}

export interface WorkspacePublicInfo {
  id: WorkspaceId
  name: string
  ownerDisplayName: string
}

export interface JoinWorkspaceResponse {
  role: Role
  alreadyMember: boolean
}

export interface WorkspaceMember {
  userId: UserId
  workspaceId: WorkspaceId
  role: Role
  username: string
}

export interface FileEntry {
  id: FileId
  workspaceId: WorkspaceId
  path: string
  kind: FileKind
  docId?: DocId
  binaryHash?: string
  binarySize?: number
  /** POSIX mode bits & 0o777, captured at upload. Null on Windows or for unknown files. */
  mode?: number | null
  createdAt: string
  updatedAt: string
}

export interface WorkspaceChange {
  revision: number
  type:
    | "fileCreated"
    | "fileRenamed"
    | "fileDeleted"
    | "binaryUpdated"
    | "fileContentChanged"
    | "permissionChanged"
    | "workspaceRenamed"
  fileId?: FileId
  path?: string
  oldPath?: string
  kind?: FileKind
  hash?: string
  size?: number
}

export interface SnapshotFile {
  fileId: FileId
  path: string
  kind: FileKind
  docId?: DocId
  size?: number
  hash?: string
}

export interface WorkspaceSnapshot {
  revision: number
  files: SnapshotFile[]
}
