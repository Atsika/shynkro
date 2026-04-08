/**
 * Chunked + resumable binary upload client (D1).
 *
 * Sends a binary file to the server in fixed-size chunks via the multi-step
 * upload-session protocol. Resume across reconnects is supported via the
 * server's GET /status endpoint — we ask which chunk indices already arrived
 * and skip them. Resume across extension restarts is *not* yet supported in
 * this iteration; if the extension reloads mid-upload, the partial session
 * gets garbage-collected by expireUploadSessions on the server (default 60
 * minute TTL).
 *
 * The hash and total size are computed by streaming the local file once at
 * the start — never holding more than 64 KB in memory regardless of file size.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as vscode from "vscode"
import type { FileId, WorkspaceId } from "@shynkro/shared"
import { log } from "../logger"

export interface ChunkedUploadResult {
  hash: string
  size: number
}

interface BeginResponse {
  sessionId: string
  chunkSize: number
  totalChunks: number
  expiresAt: string
}

interface StatusResponse {
  sessionId: string
  totalChunks: number
  receivedChunks: number[]
  complete: boolean
}

interface CompleteResponse {
  hash: string
  size: number
}

/** Default chunk size when the server doesn't override. Matches the server default. */
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

/** Files smaller than this stay on the single-shot PUT /blob path. */
export const CHUNKED_UPLOAD_THRESHOLD = 16 * 1024 * 1024

/**
 * Compute SHA-256 of a file by streaming it. Returns the hex digest plus the
 * total byte count, both in one pass — saves a redundant fs.statSync.
 */
export async function computeFileHashAndSize(filePath: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hasher = crypto.createHash("sha256")
    let size = 0
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })
    stream.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      hasher.update(buf)
      size += buf.byteLength
    })
    stream.on("end", () => resolve({ hash: hasher.digest("hex"), size }))
    stream.on("error", reject)
  })
}

/**
 * Read a single chunk from a local file at [start, start+length). Used to
 * push the next outstanding chunk over HTTP without holding the full file
 * in memory.
 */
async function readChunk(filePath: string, start: number, length: number): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, "r")
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fd.read(buf, 0, length, start)
    return bytesRead < length ? buf.subarray(0, bytesRead) : buf
  } finally {
    await fd.close()
  }
}

export interface ChunkedUploaderDeps {
  baseUrl: string
  getToken: () => Promise<string | undefined>
}

export class ChunkedUploader {
  constructor(private readonly deps: ChunkedUploaderDeps) {}

  /**
   * Upload a local binary file via the chunked protocol. Reports progress to
   * VS Code's withProgress UI so the user can see "uploading scan.zip 234/512 MB".
   */
  async upload(workspaceId: WorkspaceId, fileId: FileId, localPath: string): Promise<ChunkedUploadResult> {
    const { hash, size } = await computeFileHashAndSize(localPath)
    if (size === 0) {
      // Edge case: an empty file. The server still expects an upload session
      // (with totalChunks=0) and an immediate complete.
      const session = await this.beginSession(workspaceId, fileId, { totalSize: 0, sha256: hash, fileName: pathBasename(localPath) })
      const result = await this.completeSession(workspaceId, session.sessionId)
      return { hash: result.hash, size: result.size }
    }

    const session = await this.beginSession(workspaceId, fileId, {
      totalSize: size,
      sha256: hash,
      fileName: pathBasename(localPath),
    })

    log.appendLine(`[chunked-upload] ${pathBasename(localPath)}: ${session.totalChunks} chunks of ${session.chunkSize} bytes`)

    // Ask the server which chunks (if any) it already has — handles resume
    // across reconnects within the same upload attempt.
    const status = await this.getStatus(workspaceId, session.sessionId)
    const received = new Set(status.receivedChunks)

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Shynkro: uploading ${pathBasename(localPath)}`,
        cancellable: false,
      },
      async (progress) => {
        let bytesUploaded = received.size * session.chunkSize
        for (let index = 0; index < session.totalChunks; index++) {
          if (received.has(index)) continue
          const start = index * session.chunkSize
          const length = Math.min(session.chunkSize, size - start)
          const chunk = await readChunk(localPath, start, length)
          await this.putChunk(workspaceId, session.sessionId, index, chunk)
          bytesUploaded += length
          const pct = Math.min(100, Math.round((bytesUploaded / size) * 100))
          progress.report({
            message: `${formatBytes(bytesUploaded)} / ${formatBytes(size)} (${pct}%)`,
            increment: (length / size) * 100,
          })
        }
        const result = await this.completeSession(workspaceId, session.sessionId)
        return { hash: result.hash, size: result.size }
      }
    )
  }

  // ---- HTTP helpers ----

  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}
    const token = await this.deps.getToken()
    if (token) headers["Authorization"] = `Bearer ${token}`
    return headers
  }

  private async beginSession(
    workspaceId: WorkspaceId,
    fileId: FileId,
    body: { totalSize: number; sha256: string; chunkSize?: number; fileName?: string }
  ): Promise<BeginResponse> {
    const headers = { ...(await this.authHeaders()), "Content-Type": "application/json" }
    const res = await fetch(
      `${this.deps.baseUrl}/api/v1/workspaces/${workspaceId}/files/${fileId}/upload-session`,
      { method: "POST", headers, body: JSON.stringify({ ...body, chunkSize: body.chunkSize ?? DEFAULT_CHUNK_SIZE }) }
    )
    if (!res.ok) throw new Error(`upload-session begin failed: ${res.status} ${await safeText(res)}`)
    return (await res.json()) as BeginResponse
  }

  private async getStatus(workspaceId: WorkspaceId, sessionId: string): Promise<StatusResponse> {
    const headers = await this.authHeaders()
    const res = await fetch(
      `${this.deps.baseUrl}/api/v1/workspaces/${workspaceId}/upload-session/${sessionId}/status`,
      { headers }
    )
    if (!res.ok) throw new Error(`upload-session status failed: ${res.status} ${await safeText(res)}`)
    return (await res.json()) as StatusResponse
  }

  private async putChunk(
    workspaceId: WorkspaceId,
    sessionId: string,
    index: number,
    chunk: Buffer
  ): Promise<void> {
    const headers = {
      ...(await this.authHeaders()),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(chunk.byteLength),
    }
    const res = await fetch(
      `${this.deps.baseUrl}/api/v1/workspaces/${workspaceId}/upload-session/${sessionId}/chunk/${index}`,
      { method: "PUT", headers, body: new Uint8Array(chunk) }
    )
    if (!res.ok) {
      throw new Error(`chunk ${index} upload failed: ${res.status} ${await safeText(res)}`)
    }
  }

  private async completeSession(
    workspaceId: WorkspaceId,
    sessionId: string
  ): Promise<CompleteResponse> {
    const headers = { ...(await this.authHeaders()), "Content-Type": "application/json" }
    const res = await fetch(
      `${this.deps.baseUrl}/api/v1/workspaces/${workspaceId}/upload-session/${sessionId}/complete`,
      { method: "POST", headers }
    )
    if (!res.ok) throw new Error(`upload-session complete failed: ${res.status} ${await safeText(res)}`)
    return (await res.json()) as CompleteResponse
  }
}

function pathBasename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  return idx >= 0 ? p.slice(idx + 1) : p
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return res.statusText
  }
}
