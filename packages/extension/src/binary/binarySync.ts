import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import type { FileId, WorkspaceId } from "@shynkro/shared"
import type { RestClient } from "../api/restClient"
import type { StateDb } from "../state/stateDb"
import type { FileWatcher } from "../sync/fileWatcher"

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

    const data = fs.readFileSync(localPath)
    await this.restClient.uploadBlob(workspaceId, fileId, data, hash)
    this.stateDb.updateBinaryHash(fileId, hash)
  }

  async download(fileId: FileId, localPath: string, workspaceId: WorkspaceId): Promise<void> {
    const { data, hash } = await this.restClient.downloadBlob(workspaceId, fileId)
    const dir = path.dirname(localPath)
    fs.mkdirSync(dir, { recursive: true })
    this.fileWatcher.addWriteTag(localPath)
    fs.writeFileSync(localPath, data)
    this.stateDb.updateBinaryHash(fileId, hash)
  }
}
