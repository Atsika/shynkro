import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as crypto from "crypto"
import type { FileId, WorkspaceId } from "@shynkro/shared"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { FileWatcher } from "../sync/fileWatcher"
import { log } from "../logger"

const IS_WINDOWS = os.platform() === "win32"

export class BinarySync {
  constructor(
    private readonly restClient: RestClient,
    private readonly stateDb: StateDb,
    private readonly workspaceRoot: string,
    private readonly fileWatcher: FileWatcher
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

  async upload(fileId: FileId, localPath: string, workspaceId: WorkspaceId): Promise<void> {
    const hash = await this.computeHash(localPath)
    const row = this.stateDb.getFileById(fileId)
    if (row?.binaryHash === hash) return // no change

    // Capture mode bits before upload so we can both forward them to the server
    // (for cross-machine restoration) and persist locally. On Windows we leave
    // the existing server-side value untouched by passing null.
    let mode: number | null = null
    if (!IS_WINDOWS) {
      try {
        mode = fs.statSync(localPath).mode & 0o777
      } catch {
        // path vanished between hash and stat — best effort
      }
    }

    const data = fs.readFileSync(localPath)
    await this.restClient.uploadBlob(workspaceId, fileId, data, hash, mode)
    this.stateDb.updateBinaryHash(fileId, hash)
    if (mode !== null) this.stateDb.setFileMode(fileId, mode)
  }

  async download(fileId: FileId, localPath: string, workspaceId: WorkspaceId): Promise<void> {
    const { data, hash, mode } = await this.restClient.downloadBlob(workspaceId, fileId)
    const dir = path.dirname(localPath)
    fs.mkdirSync(dir, { recursive: true })
    this.fileWatcher.addWriteTag(localPath)
    fs.writeFileSync(localPath, data)
    this.stateDb.updateBinaryHash(fileId, hash)
    // Persist whatever mode the server returned (if any) so subsequent uploads from
    // this client also know the canonical bits.
    if (mode !== null) this.stateDb.setFileMode(fileId, mode)
    // Restore POSIX mode bits if known. No-op on Windows where the bits we store
    // from POSIX peers don't map cleanly onto NTFS ACLs.
    if (!IS_WINDOWS && mode !== null) {
      try {
        fs.chmodSync(localPath, mode)
      } catch (err) {
        log.appendLine(`[binarySync] chmod ${mode.toString(8)} failed for ${localPath}: ${err}`)
      }
    }
  }
}
