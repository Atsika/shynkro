/** Metadata returned by `list()` for each blob currently in storage. */
export interface BlobInfo {
  hash: string
  /** Bytes on disk (may differ from logical size for compressed backends). */
  size: number
  /** Last-modified time in epoch ms — used by the orphan GC for grace-period checks. */
  mtimeMs: number
}

export interface StorageBackend {
  put(hash: string, data: Uint8Array): Promise<void>
  get(hash: string): Promise<Uint8Array>
  exists(hash: string): Promise<boolean>
  delete(hash: string): Promise<void>
  /**
   * Yield every blob currently in storage. Used by the orphan-GC job to find
   * blobs that no longer have a `file_entries.binary_hash` referencing them.
   * Implementations should be lazy (async generator) so very large stores
   * don't OOM the GC pass.
   */
  list(): AsyncIterable<BlobInfo>
}
