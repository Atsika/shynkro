import type {
  DocId,
  FileEntry,
  FileId,
  FileKind,
  ImportSessionId,
  JoinWorkspaceResponse,
  Role,
  UserId,
  UserInfo,
  WorkspaceChange,
  WorkspaceId,
  WorkspaceInfo,
  WorkspaceMember,
  WorkspacePublicInfo,
  WorkspaceSnapshot,
} from "./workspace.js"

// Auth

export interface RegisterBody {
  username: string
  password: string
}

export interface LoginBody {
  username: string
  password: string
}

export interface RefreshBody {
  refreshToken: string
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
}

export interface AuthResponse extends AuthTokens {
  user: UserInfo
}

// Health

export interface HealthResponse {
  status: "ok"
  apiVersion: number
  minExtensionVersion: string
}

// Workspaces

export interface CreateWorkspaceBody {
  name: string
}

export interface UpdateWorkspaceBody {
  name?: string
}

export interface ChangesResponse {
  currentRevision: number
  changes: WorkspaceChange[]
}

// Import

export interface BeginImportResponse {
  importId: ImportSessionId
}

export interface ImportFileBody {
  path: string
  kind: FileKind
  content?: string   // base64 for binary, plain text for text
  hash?: string
}

// File tree

export interface CreateFileBody {
  path: string
  kind: FileKind
  content?: string
}

export interface RenameFileBody {
  path: string
}

// Members

export interface InviteMemberBody {
  username: string
  role: Role
}

export interface UpdateMemberBody {
  role: Role
}

export interface TransferOwnershipBody {
  newOwnerId: UserId
}

// Re-export for convenience
export type {
  DocId,
  FileEntry,
  FileId,
  FileKind,
  ImportSessionId,
  JoinWorkspaceResponse,
  Role,
  UserId,
  UserInfo,
  WorkspaceChange,
  WorkspaceId,
  WorkspaceInfo,
  WorkspaceMember,
  WorkspacePublicInfo,
  WorkspaceSnapshot,
}
