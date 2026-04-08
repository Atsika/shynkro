import type {
  AuthResponse,
  AuthTokens,
  BeginImportResponse,
  ChangesResponse,
  CreateFileBody,
  CreateWorkspaceBody,
  HealthResponse,
  ImportFileBody,
  InviteMemberBody,
  JoinWorkspaceResponse,
  LoginBody,
  RefreshBody,
  RegisterBody,
  RenameFileBody,
  Role,
  UpdateMemberBody,
  UserId,
  UserInfo,
  WorkspaceId,
  WorkspaceInfo,
  WorkspaceMember,
  WorkspacePublicInfo,
  WorkspaceSnapshot,
  FileId,
  FileEntry,
} from "@shynkro/shared"

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** Build the X-Shynkro-Op-Id header payload, or undefined when no opId is present. */
function opIdHeaders(opId: string | undefined): Record<string, string> | undefined {
  return opId ? { "X-Shynkro-Op-Id": opId } : undefined
}

export class RestClient {
  private baseUrl = "http://localhost:3000"

  constructor(private readonly getToken: () => Promise<string | undefined>) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, "")
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const token = await this.getToken()
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    }
    if (token) headers["Authorization"] = `Bearer ${token}`

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      const parts: string[] = []
      let e: unknown = err
      while (e instanceof Error) {
        parts.push(e.message)
        e = e.cause
      }
      throw new Error(`Cannot connect to ${this.baseUrl} — ${parts.join(": ")}`)
    }

    if (!res.ok) {
      let code = "UNKNOWN"
      let message = res.statusText
      try {
        const err = (await res.json()) as { message?: string; code?: string }
        if (err.message) message = err.message
        if (err.code) code = err.code
      } catch {}
      throw new ApiError(res.status, code, message)
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T
    }
    return res.json() as Promise<T>
  }

  // Health (unauthenticated)
  health(): Promise<HealthResponse> {
    return this.request("GET", "/api/v1/health")
  }

  // Auth (unauthenticated)
  login(body: LoginBody): Promise<AuthResponse> {
    return this.request("POST", "/api/v1/auth/login", body)
  }
  register(body: RegisterBody): Promise<AuthResponse> {
    return this.request("POST", "/api/v1/auth/register", body)
  }
  refresh(body: RefreshBody): Promise<AuthTokens> {
    return this.request("POST", "/api/v1/auth/refresh", body)
  }
  me(): Promise<UserInfo> {
    return this.request("GET", "/api/v1/auth/me")
  }

  // Workspaces
  createWorkspace(body: CreateWorkspaceBody): Promise<WorkspaceInfo> {
    return this.request("POST", "/api/v1/workspaces", body)
  }
  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return this.request("GET", "/api/v1/workspaces")
  }
  getWorkspace(id: WorkspaceId): Promise<WorkspaceInfo> {
    return this.request("GET", `/api/v1/workspaces/${id}`)
  }
  deleteWorkspace(id: WorkspaceId): Promise<void> {
    return this.request("DELETE", `/api/v1/workspaces/${id}`)
  }
  updateWorkspace(id: WorkspaceId, name: string): Promise<{ ok: boolean }> {
    return this.request("PATCH", `/api/v1/workspaces/${id}`, { name })
  }
  getTree(id: WorkspaceId): Promise<{ files: FileEntry[] }> {
    return this.request("GET", `/api/v1/workspaces/${id}/tree`)
  }
  getWorkspaceInfo(id: WorkspaceId): Promise<WorkspacePublicInfo> {
    return this.request("GET", `/api/v1/workspaces/${id}/info`)
  }
  joinWorkspace(id: WorkspaceId): Promise<JoinWorkspaceResponse> {
    return this.request("POST", `/api/v1/workspaces/${id}/join`)
  }
  getSnapshot(id: WorkspaceId): Promise<WorkspaceSnapshot> {
    return this.request("GET", `/api/v1/workspaces/${id}/snapshot`)
  }
  getChanges(id: WorkspaceId, since: number): Promise<ChangesResponse> {
    return this.request("GET", `/api/v1/workspaces/${id}/changes?since=${since}`)
  }

  // Import
  beginImport(workspaceId: WorkspaceId): Promise<BeginImportResponse> {
    return this.request("POST", `/api/v1/workspaces/${workspaceId}/import/begin`)
  }
  importFile(workspaceId: WorkspaceId, importId: string, body: ImportFileBody): Promise<void> {
    return this.request("POST", `/api/v1/workspaces/${workspaceId}/import/${importId}/files`, body)
  }
  commitImport(workspaceId: WorkspaceId, importId: string): Promise<void> {
    return this.request("POST", `/api/v1/workspaces/${workspaceId}/import/${importId}/commit`)
  }
  abortImport(workspaceId: WorkspaceId, importId: string): Promise<void> {
    return this.request("POST", `/api/v1/workspaces/${workspaceId}/import/${importId}/abort`)
  }

  // Files
  //
  // The optional `opId` parameter is the client-generated UUID from a pending_ops
  // queue entry; when present it is forwarded as X-Shynkro-Op-Id so the server
  // can dedupe a replay after an extension crash between "applied" and "acked".
  // Direct online ops pass no opId — they can't replay.
  createFile(workspaceId: WorkspaceId, body: CreateFileBody, opId?: string): Promise<FileEntry> {
    return this.request("POST", `/api/v1/workspaces/${workspaceId}/files`, body, opIdHeaders(opId))
  }
  renameFile(workspaceId: WorkspaceId, fileId: FileId, body: RenameFileBody, opId?: string): Promise<void> {
    return this.request("PATCH", `/api/v1/workspaces/${workspaceId}/files/${fileId}`, body, opIdHeaders(opId))
  }
  deleteFile(workspaceId: WorkspaceId, fileId: FileId, opId?: string): Promise<void> {
    return this.request("DELETE", `/api/v1/workspaces/${workspaceId}/files/${fileId}`, undefined, opIdHeaders(opId))
  }
  getFile(workspaceId: WorkspaceId, fileId: FileId): Promise<FileEntry> {
    return this.request("GET", `/api/v1/workspaces/${workspaceId}/files/${fileId}`)
  }
  async getFileContent(workspaceId: WorkspaceId, fileId: FileId): Promise<string> {
    const token = await this.getToken()
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/workspaces/${workspaceId}/files/${fileId}/content`, { headers })
    } catch (err) {
      throw new Error(`Cannot connect to ${this.baseUrl} — ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) {
      let code = "UNKNOWN", message = res.statusText
      try { const err = await res.json() as { message?: string; code?: string }; if (err.message) message = err.message; if (err.code) code = err.code } catch {}
      throw new ApiError(res.status, code, message)
    }
    return res.text()
  }

  // Members
  listMembers(workspaceId: WorkspaceId): Promise<WorkspaceMember[]> {
    return this.request("GET", `/api/v1/workspaces/${workspaceId}/members`)
  }
  inviteMember(workspaceId: WorkspaceId, body: InviteMemberBody): Promise<void> {
    return this.request("POST", `/api/v1/workspaces/${workspaceId}/members`, body)
  }
  updateMemberRole(workspaceId: WorkspaceId, userId: UserId, role: Role): Promise<void> {
    return this.request("PATCH", `/api/v1/workspaces/${workspaceId}/members/${userId}`, { role } satisfies UpdateMemberBody)
  }
  removeMember(workspaceId: WorkspaceId, userId: UserId): Promise<void> {
    return this.request("DELETE", `/api/v1/workspaces/${workspaceId}/members/${userId}`)
  }

  // Blobs
  async uploadBlob(workspaceId: WorkspaceId, fileId: FileId, data: Uint8Array, hash: string, mode?: number | null): Promise<void> {
    const token = await this.getToken()
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Content-Hash": hash,
    }
    if (mode !== undefined && mode !== null) headers["X-File-Mode"] = String(mode & 0o777)
    if (token) headers["Authorization"] = `Bearer ${token}`
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/workspaces/${workspaceId}/files/${fileId}/blob`, {
        method: "PUT",
        headers,
        body: data,
      })
    } catch (err) {
      throw new Error(`Cannot connect to ${this.baseUrl} — ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new ApiError(res.status, "UPLOAD_FAILED", res.statusText)
  }

  async downloadBlob(workspaceId: WorkspaceId, fileId: FileId): Promise<{ data: Uint8Array; hash: string; mode: number | null }> {
    const token = await this.getToken()
    const headers: Record<string, string> = {}
    if (token) headers["Authorization"] = `Bearer ${token}`
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/workspaces/${workspaceId}/files/${fileId}/blob`, { headers })
    } catch (err) {
      throw new Error(`Cannot connect to ${this.baseUrl} — ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new ApiError(res.status, "DOWNLOAD_FAILED", res.statusText)
    const hash = res.headers.get("X-Content-Hash") ?? ""
    const modeHeader = res.headers.get("X-File-Mode")
    const parsed = modeHeader !== null ? Number.parseInt(modeHeader, 10) : NaN
    const mode = Number.isFinite(parsed) ? parsed & 0o777 : null
    const buf = await res.arrayBuffer()
    return { data: new Uint8Array(buf), hash, mode }
  }
}
