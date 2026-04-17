import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as crypto from "crypto"
import type { FileId, WorkspaceId } from "@shynkro/shared"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { FileWatcher } from "../sync/fileWatcher"
import { log } from "../logger"
import { atomicWriteFileSync } from "../text/atomicWrite"
import { ChunkedUploader, CHUNKED_UPLOAD_THRESHOLD } from "./chunkedUpload"
import { ChunkedDownloader, CHUNKED_DOWNLOAD_THRESHOLD } from "./chunkedDownload"

const IS_WINDOWS = os.platform() === "win32"

export class BinarySync {
  constructor(
    private readonly restClient: RestClient,
    private readonly stateDb: StateDb,
    private readonly workspaceRoot: string,
    private readonly fileWatcher: FileWatcher,
    /**
     * Optional dependency for the chunked upload/download path. When omitted,
     * binarySync falls back to the legacy single-shot REST endpoints — used
     * by older callers that haven't been wired up yet.
     */
    private readonly chunked?: { uploader: ChunkedUploader; downloader: ChunkedDownloader }
  ) {}

  async computeHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256")
      const stream = fs.createReadStream(filePath)
      stream.on("data", (chunk) => hash.update(chunk))
      stream.on("end", () => resolve(hash.digest("hex")))
      stream.on("error", reject)
    })
  }

  /**
   * Upload a binary file to the server.
   *
   * @param ifMatch  Concurrency guard for the binary conflict picker. When
   *                 set, server returns 412 if its current hash for this file
   *                 has moved — caller treats that as "another resolver already
   *                 pushed" and reopens the picker against the new state.
   */
  async upload(
    fileId: FileId,
    localPath: string,
    workspaceId: WorkspaceId,
    ifMatch?: string | null,
  ): Promise<void> {
    let stat: fs.Stats
    try {
      stat = fs.statSync(localPath)
    } catch (err) {
      log.appendLine(`[binarySync] upload stat failed for ${localPath}: ${err}`)
      return
    }
    const fileMode = !IS_WINDOWS ? (stat.mode & 0o777) : null

    // D1: route large files through the chunked + resumable path so we never
    // hold a 1 GB+ pcap in memory and a network blip mid-upload can resume
    // from the next un-acked chunk instead of starting over from byte 0.
    if (this.chunked && stat.size > CHUNKED_UPLOAD_THRESHOLD) {
      try {
        const { hash } = await this.chunked.uploader.upload(workspaceId, fileId, localPath)
        this.stateDb.setSyncedBinaryHash(fileId, hash)
        if (fileMode !== null) this.stateDb.setFileMode(fileId, fileMode)
        log.appendLine(`[binarySync] chunked upload complete for ${path.basename(localPath)} (${stat.size} bytes, hash=${hash.slice(0, 12)}…)`)
        return
      } catch (err) {
        log.appendLine(`[binarySync] chunked upload failed for ${localPath}: ${err}`)
        throw err
      }
    }

    // Single-shot path for files at-or-below the threshold.
    const hash = await this.computeHash(localPath)
    const row = this.stateDb.getFileById(fileId)
    // Skip only if both the local hash AND the synced hash already match —
    // re-uploading after a failed earlier attempt is the desired behavior when
    // local and synced have diverged.
    if (row?.binaryHash === hash && row?.syncedBinaryHash === hash) return

    const data = fs.readFileSync(localPath)
    await this.restClient.uploadBlob(workspaceId, fileId, data, hash, fileMode, ifMatch)
    this.stateDb.setSyncedBinaryHash(fileId, hash)
    if (fileMode !== null) this.stateDb.setFileMode(fileId, fileMode)
  }

  async download(fileId: FileId, localPath: string, workspaceId: WorkspaceId): Promise<void> {
    // D1: probe the server-side size cheaply via a Range probe and route
    // anything above the threshold through the streaming chunked downloader.
    // The probe is a one-byte range request — costs nothing relative to a
    // full GET we'd otherwise have to discard.
    if (this.chunked) {
      const probedSize = await this.probeServerSize(fileId, workspaceId)
      if (probedSize !== null && probedSize > CHUNKED_DOWNLOAD_THRESHOLD) {
        try {
          this.fileWatcher.addWriteTag(localPath)
          const result = await this.chunked.downloader.download(workspaceId, fileId, localPath)
          this.stateDb.setSyncedBinaryHash(fileId, result.hash)
          if (result.mode !== null) this.stateDb.setFileMode(fileId, result.mode)
          log.appendLine(`[binarySync] chunked download complete for ${path.basename(localPath)} (${result.size} bytes)`)
          return
        } catch (err) {
          log.appendLine(`[binarySync] chunked download failed for ${localPath}: ${err}`)
          throw err
        }
      }
    }

    const { data, hash, mode } = await this.restClient.downloadBlob(workspaceId, fileId)
    // Atomic write: a crash mid-transfer leaves the target untouched.
    this.fileWatcher.addWriteTag(localPath)
    atomicWriteFileSync(localPath, data)
    this.stateDb.setSyncedBinaryHash(fileId, hash)
    if (mode !== null) this.stateDb.setFileMode(fileId, mode)
    if (!IS_WINDOWS && mode !== null) {
      try {
        fs.chmodSync(localPath, mode)
      } catch (err) {
        log.appendLine(`[binarySync] chmod ${mode.toString(8)} failed for ${localPath}: ${err}`)
      }
    }
  }

  /**
   * Cheap server-side size probe — reuses restClient.probeBlobSize, which
   * issues a HEAD-shaped Range request and parses Content-Range. Returns
   * null on any failure so the caller falls back to the single-shot path.
   */
  private async probeServerSize(fileId: FileId, workspaceId: WorkspaceId): Promise<number | null> {
    try {
      const { totalSize } = await this.restClient.probeBlobSize(workspaceId, fileId)
      return totalSize
    } catch (err) {
      log.appendLine(`[binarySync] probeServerSize failed: ${err}`)
      return null
    }
  }
}
