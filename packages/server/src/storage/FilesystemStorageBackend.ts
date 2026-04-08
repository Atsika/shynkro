import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { join } from "node:path"
import type { BlobInfo, StorageBackend } from "./StorageBackend.js"

const UPLOAD_SESSIONS_DIR = ".upload-sessions"

export class FilesystemStorageBackend implements StorageBackend {
  constructor(private readonly root: string) {}

  // ---- Chunked upload session helpers (D1) ----

  private static isValidSessionId(sessionId: string): boolean {
    // UUID-shaped — disallows path traversal characters in the session ID.
    return /^[0-9a-f-]{8,64}$/.test(sessionId)
  }

  private sessionDir(sessionId: string): string {
    if (!FilesystemStorageBackend.isValidSessionId(sessionId)) {
      throw new Error(`Invalid session id: ${sessionId}`)
    }
    return join(this.root, UPLOAD_SESSIONS_DIR, sessionId)
  }

  private chunkPath(sessionId: string, index: number): string {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid chunk index: ${index}`)
    }
    return join(this.sessionDir(sessionId), `${index}.bin`)
  }

  /** Persist a single chunk for a chunked upload. Idempotent — overwrites prior bytes at this index. */
  async writeChunk(sessionId: string, index: number, data: Uint8Array): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await mkdir(dir, { recursive: true })
    const target = this.chunkPath(sessionId, index)
    const tmp = `${target}.tmp`
    await Bun.write(tmp, data.byteLength > 0 ? data : Buffer.alloc(0))
    await rename(tmp, target)
  }

  /** List the indices of every chunk currently on disk for a session. */
  async listChunkIndices(sessionId: string): Promise<number[]> {
    const dir = this.sessionDir(sessionId)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    const indices: number[] = []
    for (const name of entries) {
      const m = name.match(/^(\d+)\.bin$/)
      if (m) indices.push(Number.parseInt(m[1]!, 10))
    }
    indices.sort((a, b) => a - b)
    return indices
  }

  /**
   * Assemble all chunks for a session into a single blob, hashing on the fly.
   * Returns the SHA-256 hex of the assembled bytes and the total size. The
   * resulting blob is moved into the regular storage layout under its content
   * hash, so callers should compare the returned hash with the expected one
   * before persisting any DB row pointing at it.
   */
  async assembleSession(sessionId: string, totalChunks: number): Promise<{ hash: string; size: number }> {
    const dir = this.sessionDir(sessionId)
    const tmpAssembled = join(dir, "assembled.tmp")
    const hasher = createHash("sha256")
    let size = 0

    // Write chunks sequentially into one file. We do not load any individual
    // chunk fully into memory beyond what createReadStream's buffer holds.
    const out = createWriteStream(tmpAssembled)
    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = this.chunkPath(sessionId, i)
        // Stream chunk → assembled file, also tee through the hasher.
        const input = createReadStream(chunkPath)
        await new Promise<void>((resolve, reject) => {
          input.on("data", (buf: string | Buffer) => {
            const b = typeof buf === "string" ? Buffer.from(buf) : buf
            hasher.update(b)
            size += b.byteLength
            if (!out.write(b)) input.pause()
          })
          out.on("drain", () => input.resume())
          input.on("end", () => resolve())
          input.on("error", reject)
        })
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err: Error | null | undefined) => err ? reject(err) : resolve()))
    }

    const hash = hasher.digest("hex")

    // Move the assembled file into the canonical blob path keyed by hash.
    await this.ensureDir(hash)
    const dest = this.blobPath(hash)
    await rename(tmpAssembled, dest)

    return { hash, size }
  }

  /** Remove every artefact (chunks + assembled tmp) for a session. */
  async cleanupSession(sessionId: string): Promise<void> {
    try {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }

  /** Open a streaming read of the blob — used by Range responses for chunked download. */
  blobReadStream(hash: string, start?: number, end?: number): NodeJS.ReadableStream {
    const opts: { start?: number; end?: number } = {}
    if (start !== undefined) opts.start = start
    if (end !== undefined) opts.end = end
    return createReadStream(this.blobPath(hash), opts)
  }

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

  /**
   * Walk the two-level fan-out directory layout (root/aa/bb/<hash>) and yield
   * every blob. Async generator so an enormous store can be processed without
   * loading the full file list into memory.
   */
  async *list(): AsyncIterable<BlobInfo> {
    let level1: string[]
    try {
      level1 = await readdir(this.root)
    } catch {
      return // root doesn't exist yet — nothing to list
    }
    for (const a of level1) {
      // Top-level entries should be 2-char hex prefixes; skip anything else
      // (like the `.upload-sessions/` directory used by D1).
      if (!/^[0-9a-f]{2}$/.test(a)) continue
      const dirA = join(this.root, a)
      let level2: string[]
      try {
        level2 = await readdir(dirA)
      } catch {
        continue
      }
      for (const b of level2) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue
        const dirB = join(dirA, b)
        let files: string[]
        try {
          files = await readdir(dirB)
        } catch {
          continue
        }
        for (const name of files) {
          // Filter out in-flight `.tmp` sidecars from put().
          if (!/^[0-9a-f]{64}$/.test(name)) continue
          const path = join(dirB, name)
          let st: Awaited<ReturnType<typeof stat>>
          try {
            st = await stat(path)
          } catch {
            continue
          }
          yield { hash: name, size: st.size, mtimeMs: st.mtimeMs }
        }
      }
    }
  }
}
