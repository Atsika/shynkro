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
  /** True if more pages are available past this response. */
  hasMore?: boolean
  /** Offset to pass on the next page request, or null when the stream is drained. */
  nextOffset?: number | null
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
  /** POSIX mode bits & 0o777, captured locally on POSIX systems. */
  mode?: number
}

export interface RenameFileBody {
  path: string
}

// Chunked + resumable binary upload (D1)

export interface BeginUploadSessionBody {
  totalSize: number
  sha256: string
  chunkSize?: number
  fileName?: string
}

export interface BeginUploadSessionResponse {
  sessionId: string
  chunkSize: number
  totalChunks: number
  expiresAt: string
}

export interface UploadSessionStatus {
  sessionId: string
  totalChunks: number
  receivedChunks: number[]
  complete: boolean
}

export interface CompleteUploadSessionResponse {
  hash: string
  size: number
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
