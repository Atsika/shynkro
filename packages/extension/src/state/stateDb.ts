import { DatabaseSync } from "node:sqlite"
import type { FileMapRow } from "../types"

export class StateDb {
  private db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sync_state (
        workspace_id TEXT PRIMARY KEY,
        revision     INTEGER NOT NULL DEFAULT 0,
        last_sync_at TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS file_map (
        file_id     TEXT PRIMARY KEY,
        path        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        doc_id      TEXT,
        binary_hash TEXT,
        deleted     INTEGER NOT NULL DEFAULT 0,
        UNIQUE(path)
      );
      CREATE TABLE IF NOT EXISTS pending_ops (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        op_type    TEXT NOT NULL,
        path       TEXT NOT NULL,
        kind       TEXT,
        content    TEXT,
        file_id    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    // Add the deleted column to existing databases that predate this migration.
    // SQLite does not support ADD COLUMN IF NOT EXISTS, so we swallow the error when
    // the column already exists.
    try {
      this.db.exec("ALTER TABLE file_map ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
    } catch {
      // Column already present — nothing to do.
    }
    // Drop the now-redundant deleted_paths table if it exists from a previous version.
    this.db.exec("DROP TABLE IF EXISTS deleted_paths")
  }

  getRevision(workspaceId: string): number {
    const row = this.db
      .prepare("SELECT revision FROM sync_state WHERE workspace_id = ?")
      .get(workspaceId) as { revision: number } | undefined
    return row?.revision ?? 0
  }

  setRevision(workspaceId: string, revision: number): void {
    this.db
      .prepare(`
        INSERT INTO sync_state (workspace_id, revision, last_sync_at)
        VALUES (?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET revision = excluded.revision, last_sync_at = excluded.last_sync_at
      `)
      .run(workspaceId, revision, new Date().toISOString())
  }

  getFileByPath(filePath: string): FileMapRow | undefined {
    return this.db
      .prepare("SELECT file_id as fileId, path, kind, doc_id as docId, binary_hash as binaryHash FROM file_map WHERE path = ? AND deleted = 0")
      .get(filePath) as FileMapRow | undefined
  }

  getFileById(fileId: string): FileMapRow | undefined {
    return this.db
      .prepare("SELECT file_id as fileId, path, kind, doc_id as docId, binary_hash as binaryHash FROM file_map WHERE file_id = ? AND deleted = 0")
      .get(fileId) as FileMapRow | undefined
  }

  upsertFile(fileId: string, filePath: string, kind: string, docId?: string, binaryHash?: string): void {
    this.db
      .prepare(`
        INSERT INTO file_map (file_id, path, kind, doc_id, binary_hash, deleted)
        VALUES (?, ?, ?, ?, ?, 0)
        ON CONFLICT(file_id) DO UPDATE SET
          path        = excluded.path,
          kind        = excluded.kind,
          doc_id      = COALESCE(excluded.doc_id, file_map.doc_id),
          binary_hash = COALESCE(excluded.binary_hash, file_map.binary_hash),
          deleted     = 0
      `)
      .run(fileId, filePath, kind, docId ?? null, binaryHash ?? null)
  }

  renameFile(fileId: string, newPath: string): void {
    this.db.prepare("UPDATE file_map SET path = ? WHERE file_id = ?").run(newPath, fileId)
  }

  updateBinaryHash(fileId: string, hash: string): void {
    this.db.prepare("UPDATE file_map SET binary_hash = ? WHERE file_id = ?").run(hash, fileId)
  }

  /**
   * Soft-delete: marks the row as deleted (tombstone) so that if the server re-surfaces
   * this file (e.g. after a server restart), applyCreated will re-delete it rather than
   * restoring it locally.
   */
  deleteFile(fileId: string): void {
    this.db.prepare("UPDATE file_map SET deleted = 1 WHERE file_id = ?").run(fileId)
  }

  isPathDeleted(relPath: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM file_map WHERE path = ? AND deleted = 1").get(relPath)
  }

  /**
   * Hard-delete: fully removes the row. Used when the server confirms the deletion so
   * the tombstone is no longer needed.
   */
  purgeFile(fileId: string): void {
    this.db.prepare("DELETE FROM file_map WHERE file_id = ?").run(fileId)
  }

  allFiles(): FileMapRow[] {
    return this.db
      .prepare("SELECT file_id as fileId, path, kind, doc_id as docId, binary_hash as binaryHash FROM file_map WHERE deleted = 0")
      .all() as unknown as FileMapRow[]
  }

  /** Wipe file_map and pending_ops — used by the re-link command. */
  clearForRelink(): void {
    this.db.exec("DELETE FROM file_map; DELETE FROM pending_ops;")
  }

  // ---- Offline operation queue ----

  enqueuePendingOp(op: { opType: "create" | "delete"; path: string; kind?: string; content?: string; fileId?: string }): void {
    this.db
      .prepare("INSERT INTO pending_ops (op_type, path, kind, content, file_id) VALUES (?, ?, ?, ?, ?)")
      .run(op.opType, op.path, op.kind ?? null, op.content ?? null, op.fileId ?? null)
  }

  dequeuePendingOps(): Array<{ id: number; opType: string; path: string; kind: string | null; content: string | null; fileId: string | null }> {
    return this.db
      .prepare("SELECT id, op_type as opType, path, kind, content, file_id as fileId FROM pending_ops ORDER BY id ASC")
      .all() as Array<{ id: number; opType: string; path: string; kind: string | null; content: string | null; fileId: string | null }>
  }

  removePendingOp(id: number): void {
    this.db.prepare("DELETE FROM pending_ops WHERE id = ?").run(id)
  }

  close(): void {
    this.db.close()
  }
}
