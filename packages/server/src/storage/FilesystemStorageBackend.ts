import { mkdir, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { StorageBackend } from "./StorageBackend.js"

export class FilesystemStorageBackend implements StorageBackend {
  constructor(private readonly root: string) {}

  private static isValidHash(hash: string): boolean {
    return /^[0-9a-f]{64}$/.test(hash)
  }

  private blobPath(hash: string): string {
    if (!FilesystemStorageBackend.isValidHash(hash)) {
      throw new Error(`Invalid blob hash: ${hash}`)
    }
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash)
  }

  private async ensureDir(hash: string): Promise<void> {
    const dir = join(this.root, hash.slice(0, 2), hash.slice(2, 4))
    await mkdir(dir, { recursive: true })
  }

  async put(hash: string, data: Uint8Array): Promise<void> {
    await this.ensureDir(hash)
    const dest = this.blobPath(hash)
    const tmp = dest + ".tmp"
    // Bun.write with a zero-length Uint8Array may not create the file on disk,
    // so fall back to a plain Buffer to guarantee file creation.
    await Bun.write(tmp, data.byteLength > 0 ? data : Buffer.alloc(0))
    await rename(tmp, dest)
  }

  async get(hash: string): Promise<Uint8Array> {
    const path = this.blobPath(hash)
    const file = Bun.file(path)
    if (!(await file.exists())) throw new Error(`Blob not found: ${hash}`)
    return new Uint8Array(await file.arrayBuffer())
  }

  async exists(hash: string): Promise<boolean> {
    return Bun.file(this.blobPath(hash)).exists()
  }

  async delete(hash: string): Promise<void> {
    try {
      await unlink(this.blobPath(hash))
    } catch {
      // ignore if already gone
    }
  }
}
