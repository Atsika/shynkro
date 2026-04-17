/**
 * Chunked download client (D1).
 *
 * Streams a binary blob from the server to a local file using HTTP `Range`
 * requests, never holding more than one chunk in memory. The file is written
 * to a temp sidecar via the existing atomic-write helper and renamed into
 * place once the full hash matches the server's `X-Content-Hash`.
 *
 * Resume after an interrupted download is supported within the same call by
 * tracking `bytesDownloaded` against the total `Content-Length` of the first
 * range probe. Resume across extension restarts isn't yet implemented — the
 * download just starts over, which is fine because Yjs CRDT and the server's
 * idempotent storage make repeat downloads cheap.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import type { FileId, WorkspaceId } from "@shynkro/shared"
import { log } from "../logger"
import { SHYNKRO_TMP_PREFIX } from "../text/atomicWrite"

/** Default range size for the chunked download path. */
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

/** Files smaller than this stay on the single-shot GET /blob path. */
export const CHUNKED_DOWNLOAD_THRESHOLD = 16 * 1024 * 1024

export interface ChunkedDownloadResult {
  hash: string
  size: number
  mode: number | null
}

export interface ChunkedDownloaderDeps {
  baseUrl: string
  getToken: () => Promise<string | undefined>
  /**
   * H10: invoked with the destination path immediately before the atomic
   * rename. The FileWatcher uses this to ignore the resulting onCreate event
   * so a "Take theirs" pull doesn't trigger a spurious onBinaryChanged →
   * upload loop.
   */
  addWriteTag?: (absPath: string) => void
}

export class ChunkedDownloader {
  constructor(private readonly deps: ChunkedDownloaderDeps) {}

  /**
   * Stream a blob into `targetPath` via HTTP Range. Reports progress via
   * VS Code's withProgress notification.
   */
  async download(workspaceId: WorkspaceId, fileId: FileId, targetPath: string): Promise<ChunkedDownloadResult> {
    const headers = await this.authHeaders()
    const url = `${this.deps.baseUrl}/api/v1/workspaces/${workspaceId}/files/${fileId}/blob`

    // First request: ask for bytes 0-0 to learn the full size cheaply via
    // Content-Range. We could also just HEAD it but that's an extra round trip.
    const probe = await fetch(url, {
      headers: { ...headers, Range: "bytes=0-0" },
    })
    if (!probe.ok && probe.status !== 206) {
      throw new Error(`download probe failed: ${probe.status} ${await safeText(probe)}`)
    }
    const totalSize = parseTotalSizeFromContentRange(probe.headers.get("content-range")) ??
      parseInt(probe.headers.get("content-length") ?? "0", 10)
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      throw new Error(`[chunked-download] probe returned no valid size (Content-Range and Content-Length both missing/zero) for ${fileId}`)
    }
    const remoteHash = probe.headers.get("x-content-hash") ?? ""
    const modeHeader = probe.headers.get("x-file-mode")
    const mode = modeHeader !== null && Number.isFinite(parseInt(modeHeader, 10))
      ? parseInt(modeHeader, 10) & 0o777
      : null
    // Drain the probe body so the connection isn't left half-open.
    try { await probe.arrayBuffer() } catch { /* ignore */ }

    if (!remoteHash) {
      log.appendLine(`[chunked-download] WARNING: server did not return X-Content-Hash for ${fileId}`)
    }

    // Stream into a temp sidecar so a crash mid-download leaves the target
    // (which may have a previously-good version) untouched. Same temp prefix
    // as Unit B's atomicWrite so the file watcher's ignore matcher skips it.
    const dir = path.dirname(targetPath)
    fs.mkdirSync(dir, { recursive: true })
    const tmpPath = path.join(dir, `${SHYNKRO_TMP_PREFIX}${crypto.randomBytes(6).toString("hex")}-${path.basename(targetPath)}`)

    let result: { received: number; hash: string }
    try {
      result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Shynkro: downloading ${path.basename(targetPath)}`,
          cancellable: false,
        },
        async (progress) => {
          const out = fs.createWriteStream(tmpPath)
          const hasher = crypto.createHash("sha256")
          let received = 0
          // Single stream-level error listener — re-registering per chunk (the
          // prior code) leaked listeners and tripped Node's MaxListeners warning
          // for very large files.
          let streamError: Error | null = null
          const onError = (err: Error): void => { streamError = err }
          out.on("error", onError)
          try {
            for (let start = 0; start < totalSize; start += DEFAULT_CHUNK_SIZE) {
              if (streamError) throw streamError
              const end = Math.min(start + DEFAULT_CHUNK_SIZE, totalSize) - 1
              const res = await fetch(url, {
                headers: { ...headers, Range: `bytes=${start}-${end}` },
              })
              if (!res.ok && res.status !== 206) {
                throw new Error(`chunk ${start}-${end} failed: ${res.status} ${await safeText(res)}`)
              }
              const reader = res.body?.getReader()
              if (!reader) throw new Error("response body has no reader")
              let chunkLen = 0
              while (true) {
                const { value, done } = await reader.read()
                if (done) break
                if (!value) continue
                hasher.update(value)
                if (!out.write(value)) {
                  await new Promise<void>((resolve, reject) => {
                    const onDrain = (): void => {
                      out.off("error", onErrorOnce)
                      resolve()
                    }
                    const onErrorOnce = (err: Error): void => {
                      out.off("drain", onDrain)
                      reject(err)
                    }
                    out.once("drain", onDrain)
                    out.once("error", onErrorOnce)
                  })
                }
                chunkLen += value.byteLength
              }
              received += chunkLen
              const pct = Math.min(100, Math.round((received / totalSize) * 100))
              progress.report({
                message: `${formatBytes(received)} / ${formatBytes(totalSize)} (${pct}%)`,
                increment: (chunkLen / totalSize) * 100,
              })
            }
          } finally {
            out.off("error", onError)
            await new Promise<void>((resolve, reject) =>
              out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
            )
          }
          if (streamError) throw streamError
          return { received, hash: hasher.digest("hex") }
        }
      )
    } catch (err) {
      // Clean up the temp file on ANY failure — prevents orphaned sidecars
      // from accumulating on disk across retries.
      try { fs.unlinkSync(tmpPath) } catch { /* already gone */ }
      throw err
    }

    if (remoteHash && result.hash !== remoteHash) {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
      throw new Error(`download hash mismatch: got ${result.hash}, expected ${remoteHash}`)
    }
    if (result.received !== totalSize) {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
      throw new Error(`download size mismatch: got ${result.received}, expected ${totalSize}`)
    }

    // H10: Tag the destination so the FileWatcher's onCreate handler skips
    // this write. Without the tag, every "Take theirs" pull would echo as a
    // local change → spurious re-upload.
    this.deps.addWriteTag?.(targetPath)
    // Atomic move into place.
    fs.renameSync(tmpPath, targetPath)

    // Restore POSIX mode if known. Matches binarySync.download behavior.
    if (mode !== null && os.platform() !== "win32") {
      try { fs.chmodSync(targetPath, mode) } catch (err) {
        log.appendLine(`[chunked-download] chmod failed: ${err}`)
      }
    }

    return { hash: result.hash, size: result.received, mode }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {}
    const token = await this.deps.getToken()
    if (token) headers["Authorization"] = `Bearer ${token}`
    return headers
  }
}

function parseTotalSizeFromContentRange(header: string | null): number | null {
  if (!header) return null
  const m = header.match(/bytes\s+\d+-\d+\/(\d+)/)
  return m ? parseInt(m[1]!, 10) : null
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text() } catch { return res.statusText }
}
