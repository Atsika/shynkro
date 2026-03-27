export interface StorageBackend {
  put(hash: string, data: Uint8Array): Promise<void>
  get(hash: string): Promise<Uint8Array>
  exists(hash: string): Promise<boolean>
  delete(hash: string): Promise<void>
}
