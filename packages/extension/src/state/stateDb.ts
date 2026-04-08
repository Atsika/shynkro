import { DatabaseSync } from "node:sqlite"
import type { FileMapRow } from "../types"

const SCHEMA_VERSION = 5

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
        deleted_at  TEXT,
        eol_style   TEXT,
        has_bom     INTEGER NOT NULL DEFAULT 0,
        mode        INTEGER,
        UNIQUE(path)
      );
      CREATE TABLE IF NOT EXISTS pending_ops (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        op_type    TEXT NOT NULL,
        path       TEXT NOT NULL,
        kind       TEXT,
        content    TEXT,
        file_id    TEXT,
        op_id      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS pending_yjs_frames (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id     TEXT NOT NULL,
        data       BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)

    // Apply incremental migrations for upgrades from older schemas.
    const currentVersion = this.getSchemaVersion()
    if (currentVersion < 2) {
      // V2: file_map gains eol_style, has_bom, mode for cross-OS text/binary fidelity.
      this.addColumnIfMissing("file_map", "eol_style", "TEXT")
      this.addColumnIfMissing("file_map", "has_bom", "INTEGER NOT NULL DEFAULT 0")
      this.addColumnIfMissing("file_map", "mode", "INTEGER")
    }
    if (currentVersion < 3) {
      // V3: pending_ops gains op_id so the server can dedupe replays after a
      // crash between "server applied" and "client acked".
      this.addColumnIfMissing("pending_ops", "op_id", "TEXT")
    }
    if (currentVersion < 4) {
      // V4: pending_yjs_frames — persistence for Yjs updates that are buffered
      // while the WS is disconnected. Previously held in memory on WsManager,
      // which meant any extension reload (VS Code restart, Developer: Reload
      // Window, crash) silently dropped unsent edits. CREATE TABLE IF NOT EXISTS
      // above handles fresh databases; existing installs get the table created
      // here idempotently via the same DDL.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_yjs_frames (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id     TEXT NOT NULL,
          data       BLOB NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
    }
    if (currentVersion < 5) {
      // V5: file_map gains deleted_at so the tombstone-prune job has an age to
      // compare against. Rows are tombstoned (deleted=1) when the user deletes
      // a file; the tombstone survives until the server confirms the delete or
      // the prune job sweeps anything older than the recovery window.
      this.addColumnIfMissing("file_map", "deleted_at", "TEXT")
    }
    this.setSchemaVersion(SCHEMA_VERSION)
  }

  private getSchemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined
    return row?.user_version ?? 0
  }

  private setSchemaVersion(version: number): void {
    // PRAGMA does not support parameter binding — version is a trusted constant.
    this.db.exec(`PRAGMA user_version = ${version};`)
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`)
    }
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
      .prepare(
        "SELECT file_id as fileId, path, kind, doc_id as docId, binary_hash as binaryHash, eol_style as eolStyle, has_bom as hasBom, mode FROM file_map WHERE path = ? AND deleted = 0"
      )
      .get(filePath) as FileMapRow | undefined
  }

  getFileById(fileId: string): FileMapRow | undefined {
    return this.db
      .prepare(
        "SELECT file_id as fileId, path, kind, doc_id as docId, binary_hash as binaryHash, eol_style as eolStyle, has_bom as hasBom, mode FROM file_map WHERE file_id = ? AND deleted = 0"
      )
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

  /**
   * Persist the on-disk text format of a file (line ending and BOM presence).
   * Set on first ingest and never overwritten unless the user re-imports the file.
   */
  setTextFormat(fileId: string, eolStyle: "lf" | "crlf", hasBom: boolean): void {
    this.db
      .prepare("UPDATE file_map SET eol_style = ?, has_bom = ? WHERE file_id = ?")
      .run(eolStyle, hasBom ? 1 : 0, fileId)
  }

  /** Persist the POSIX mode bits (& 0o777) of a file. No-op on Windows uploads. */
  setFileMode(fileId: string, mode: number | null): void {
    this.db
      .prepare("UPDATE file_map SET mode = ? WHERE file_id = ?")
      .run(mode, fileId)
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
   * restoring it locally. The `deleted_at` timestamp is used by pruneTombstones to
   * eventually sweep stale rows so the local database doesn't grow unbounded over months.
   */
  deleteFile(fileId: string): void {
    this.db
      .prepare("UPDATE file_map SET deleted = 1, deleted_at = datetime('now') WHERE file_id = ?")
      .run(fileId)
  }

  /**
   * Hard-delete tombstoned rows whose `deleted_at` is older than the recovery
   * window. Called once on extension activation so long-running workspaces
   * don't accumulate unlimited tombstones. Rows without `deleted_at` (legacy
   * entries from before the column existed) are also swept — they're either
   * pre-existing tombstones whose age we can't determine, or fresh ones that
   * will be recreated on the next tombstone insert.
   */
  pruneTombstones(maxAgeDays: number = 30): number {
    const result = this.db
      .prepare(`
        DELETE FROM file_map
        WHERE deleted = 1
          AND (deleted_at IS NULL OR deleted_at < datetime('now', ?))
      `)
      .run(`-${maxAgeDays} days`)
    return Number(result.changes)
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
      .prepare(
        "SELECT file_id as fileId, path, kind, doc_id as docId, binary_hash as binaryHash, eol_style as eolStyle, has_bom as hasBom, mode FROM file_map WHERE deleted = 0"
      )
      .all() as unknown as FileMapRow[]
  }

  /** Wipe file_map and pending_ops — used by the re-link command. */
  clearForRelink(): void {
    this.db.exec("DELETE FROM file_map; DELETE FROM pending_ops;")
  }

  // ---- Offline operation queue ----

  /**
   * Enqueue an offline op. For renames, `path` is the new path and the previous path
   * is encoded in `content` — keeps the schema unchanged while still letting the drain
   * step rebuild the FileRenamedMessage.
   *
   * An `op_id` UUID is generated here and persisted so that a replay after an extension
   * crash hits the server's idempotency cache and returns the original response instead
   * of creating a duplicate or producing a spurious 409.
   */
  enqueuePendingOp(op: { opType: "create" | "delete" | "rename"; path: string; kind?: string; content?: string; fileId?: string }): void {
    const opId = crypto.randomUUID()
    this.db
      .prepare("INSERT INTO pending_ops (op_type, path, kind, content, file_id, op_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(op.opType, op.path, op.kind ?? null, op.content ?? null, op.fileId ?? null, opId)
  }

  dequeuePendingOps(): Array<{ id: number; opType: string; path: string; kind: string | null; content: string | null; fileId: string | null; opId: string | null }> {
    return this.db
      .prepare("SELECT id, op_type as opType, path, kind, content, file_id as fileId, op_id as opId FROM pending_ops ORDER BY id ASC")
      .all() as Array<{ id: number; opType: string; path: string; kind: string | null; content: string | null; fileId: string | null; opId: string | null }>
  }

  removePendingOp(id: number): void {
    this.db.prepare("DELETE FROM pending_ops WHERE id = ?").run(id)
  }

  // ---- Pending Yjs frames (offline queue for binary WS updates) ----

  /**
   * Persist a Yjs binary frame that could not be sent because the WS was not
   * open. The frame is the full pre-built wire format (frameType + docId +
   * payload) so replay is a plain `ws.send(row.data)` call.
   */
  enqueueYjsFrame(docId: string, data: Uint8Array): void {
    // node:sqlite bind expects Buffer for BLOB
    const buf = Buffer.from(data)
    this.db
      .prepare("INSERT INTO pending_yjs_frames (doc_id, data) VALUES (?, ?)")
      .run(docId, buf)
  }

  allPendingYjsFrames(): Array<{ id: number; docId: string; data: Uint8Array }> {
    const rows = this.db
      .prepare("SELECT id, doc_id as docId, data FROM pending_yjs_frames ORDER BY id ASC")
      .all() as Array<{ id: number; docId: string; data: Buffer | Uint8Array }>
    return rows.map((r) => ({
      id: r.id,
      docId: r.docId,
      data: r.data instanceof Buffer ? new Uint8Array(r.data) : r.data,
    }))
  }

  removePendingYjsFrame(id: number): void {
    this.db.prepare("DELETE FROM pending_yjs_frames WHERE id = ?").run(id)
  }

  /** Count — cheap metric for health/diagnostics output. */
  pendingYjsFrameCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM pending_yjs_frames").get() as { c: number }
    return row.c
  }

  close(): void {
    this.db.close()
  }
}
