import { FilesystemStorageBackend } from "./FilesystemStorageBackend.js"
import type { StorageBackend } from "./StorageBackend.js"

export function createStorageBackend(): StorageBackend {
  const backend = process.env.SHYNKRO_STORAGE ?? "filesystem"

  if (backend === "filesystem") {
    const root = process.env.SHYNKRO_BLOB_DIR ?? "./blobs"
    return new FilesystemStorageBackend(root)
  }

  // S3 adapter will be added in Phase 3
  throw new Error(`Unknown storage backend: "${backend}". Supported values: filesystem`)
}

export type { StorageBackend }
