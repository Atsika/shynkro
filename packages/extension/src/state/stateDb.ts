import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import type { FileMapRow } from "../types"

const SCHEMA_VERSION = 7
const FILE_MAP_COLS = "file_id as fileId, path, kind, doc_id as docId, binary_hash as binaryHash, synced_binary_hash as syncedBinaryHash, eol_style as eolStyle, has_bom as hasBom, mode"

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
      -- V6: Local-first Yjs persistence. Snapshots are full encoded doc states
      -- (Y.encodeStateAsUpdate); updates are incremental deltas appended since
      -- the last snapshot. Compaction collapses N updates into a fresh snapshot.
      CREATE TABLE IF NOT EXISTS yjs_local_state (
        doc_id       TEXT PRIMARY KEY,
        snapshot     BLOB NOT NULL,
        update_count INTEGER NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS yjs_local_updates (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id           TEXT NOT NULL,
        bytes            BLOB NOT NULL,
        origin           TEXT NOT NULL,
        acked            INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL,
        client_update_id TEXT
      );
      CREATE INDEX IF NOT EXISTS yjs_local_updates_doc_idx ON yjs_local_updates(doc_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS yjs_local_updates_cuid_idx
        ON yjs_local_updates(client_update_id)
        WHERE client_update_id IS NOT NULL;
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
    if (currentVersion < 5) {
      // V5: file_map gains deleted_at so the tombstone-prune job has an age to
      // compare against. Rows are tombstoned (deleted=1) when the user deletes
      // a file; the tombstone survives until the server confirms the delete or
      // the prune job sweeps anything older than the recovery window.
      this.addColumnIfMissing("file_map", "deleted_at", "TEXT")
    }
    if (currentVersion < 6) {
      // V6: file_map gains synced_binary_hash so the binary conflict picker can
      // tell "both sides changed" (local != server AND local != last-synced)
      // from "only server changed" (local == last-synced). Migrate existing
      // rows by seeding synced_binary_hash from binary_hash — assume past sync
      // state matches current local state for the purpose of bootstrapping.
      this.addColumnIfMissing("file_map", "synced_binary_hash", "TEXT")
      this.db.exec(`
        UPDATE file_map SET synced_binary_hash = binary_hash
        WHERE synced_binary_hash IS NULL AND binary_hash IS NOT NULL;
      `)
      // Migrate any in-flight pending_yjs_frames into yjs_local_updates so the
      // new bridge can replay them on next open.
      this.db.exec(`
        INSERT INTO yjs_local_updates (doc_id, bytes, origin, acked, created_at)
        SELECT doc_id, data, 'local', 0, strftime('%s','now') * 1000
        FROM pending_yjs_frames
      `)
      this.db.exec(`DELETE FROM pending_yjs_frames;`)
    }
    if (currentVersion < 7) {
      // V7: yjs_local_updates gains client_update_id so the server can ack by
      // durable-persistence confirmation instead of the client marking rows
      // acked on ws.send (which silently loses updates when the socket dies
      // between client send and server persistUpdate).
      this.addColumnIfMissing("yjs_local_updates", "client_update_id", "TEXT")
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS yjs_local_updates_cuid_idx
          ON yjs_local_updates(client_update_id)
          WHERE client_update_id IS NOT NULL
      `)
      // Backfill UUIDs for legacy unacked local rows so they can ride the
      // new ack protocol on first reconnect after upgrade.
      const legacy = this.db
        .prepare(`
          SELECT id FROM yjs_local_updates
          WHERE origin = 'local' AND acked = 0 AND client_update_id IS NULL
        `)
        .all() as Array<{ id: number }>
      const setCuid = this.db.prepare(
        "UPDATE yjs_local_updates SET client_update_id = ? WHERE id = ?"
      )
      for (const row of legacy) setCuid.run(randomUUID(), row.id)
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

  // M4/H9: SQL injection guard. Table is a literal union. Column and type are
  // validated against a conservative whitelist pattern before interpolation —
  // ALTER TABLE does not accept bound parameters, so we must interpolate.
  private addColumnIfMissing(
    table: "file_map" | "pending_ops" | "yjs_local_updates",
    column: string,
    type: string
  ): void {
    if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
      throw new Error(`addColumnIfMissing: invalid column name ${JSON.stringify(column)}`)
    }
    if (!/^[A-Z][A-Z0-9_ ()',]*$/i.test(type)) {
      throw new Error(`addColumnIfMissing: invalid type ${JSON.stringify(type)}`)
    }
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
      .prepare(`SELECT ${FILE_MAP_COLS} FROM file_map WHERE path = ? AND deleted = 0`)
      .get(filePath) as FileMapRow | undefined
  }

  /** Case-insensitive path lookup for fast local collision pre-check. */
  getFileByPathCI(filePath: string): FileMapRow | undefined {
    return this.db
      .prepare(`SELECT ${FILE_MAP_COLS} FROM file_map WHERE lower(path) = lower(?) AND deleted = 0`)
      .get(filePath) as FileMapRow | undefined
  }

  getFileById(fileId: string): FileMapRow | undefined {
    return this.db
      .prepare(`SELECT ${FILE_MAP_COLS} FROM file_map WHERE file_id = ? AND deleted = 0`)
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
   * Update both local and last-synced binary hash atomically. Use after a
   * successful upload or download — both ends agree on this hash.
   */
  setSyncedBinaryHash(fileId: string, hash: string): void {
    this.db
      .prepare("UPDATE file_map SET binary_hash = ?, synced_binary_hash = ? WHERE file_id = ?")
      .run(hash, hash, fileId)
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

  /**
   * Return a tombstoned row for this path, if any. Used by the file-replace
   * detector so `rm foo && create foo` can un-tombstone the original fileId
   * and be treated as a content replacement rather than a delete + fresh
   * create with a new fileId.
   */
  getTombstoneByPath(relPath: string): FileMapRow | undefined {
    return this.db
      .prepare(`SELECT ${FILE_MAP_COLS} FROM file_map WHERE path = ? AND deleted = 1`)
      .get(relPath) as FileMapRow | undefined
  }

  /** Clear the tombstone flag for a fileId so the row is active again. */
  undeleteFile(fileId: string): void {
    this.db
      .prepare("UPDATE file_map SET deleted = 0, deleted_at = NULL WHERE file_id = ?")
      .run(fileId)
  }

  /** Drop any queued delete ops for a fileId (used when reviving a tombstone). */
  dropPendingDeleteOpsForFileId(fileId: string): number {
    const result = this.db
      .prepare("DELETE FROM pending_ops WHERE op_type = 'delete' AND file_id = ?")
      .run(fileId)
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
      .prepare(`SELECT ${FILE_MAP_COLS} FROM file_map WHERE deleted = 0`)
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

  // ---- Local Yjs persistence (V6) ----

  /**
   * Load the snapshot for a doc, or undefined if none exists. Always check
   * `loadYjsUpdates(docId)` afterwards and apply both in order: snapshot first,
   * then each update in id order.
   */
  loadYjsSnapshot(docId: string): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT snapshot FROM yjs_local_state WHERE doc_id = ?")
      .get(docId) as { snapshot: Buffer | Uint8Array } | undefined
    if (!row) return undefined
    return row.snapshot instanceof Buffer ? new Uint8Array(row.snapshot) : row.snapshot
  }

  /** Load all incremental updates for a doc, ordered by id. */
  loadYjsUpdates(docId: string): Array<{ id: number; bytes: Uint8Array; origin: string; acked: boolean }> {
    const rows = this.db
      .prepare("SELECT id, bytes, origin, acked FROM yjs_local_updates WHERE doc_id = ? ORDER BY id ASC")
      .all(docId) as Array<{ id: number; bytes: Buffer | Uint8Array; origin: string; acked: number }>
    return rows.map((r) => ({
      id: r.id,
      bytes: r.bytes instanceof Buffer ? new Uint8Array(r.bytes) : r.bytes,
      origin: r.origin,
      acked: r.acked === 1,
    }))
  }

  /**
   * Append an update to the local store. Returns the new row id.
   *
   * Local updates (origin='local') MUST pass a `clientUpdateId` — it is the
   * correlation key the server echoes back in `yjsUpdateAck` to mark the row
   * durably persisted. Remote rows omit it.
   */
  appendYjsUpdate(
    docId: string,
    bytes: Uint8Array,
    origin: "local" | "remote",
    acked: boolean,
    clientUpdateId?: string,
  ): number {
    const result = this.db
      .prepare(
        "INSERT INTO yjs_local_updates (doc_id, bytes, origin, acked, created_at, client_update_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        docId,
        Buffer.from(bytes),
        origin,
        acked ? 1 : 0,
        Date.now(),
        clientUpdateId ?? null,
      )
    return Number(result.lastInsertRowid)
  }

  /** All unacked local updates (origin='local' AND acked=0) for this doc, ordered by id. */
  loadUnackedLocalUpdates(docId: string): Array<{ id: number; bytes: Uint8Array; clientUpdateId: string | null }> {
    const rows = this.db
      .prepare("SELECT id, bytes, client_update_id as clientUpdateId FROM yjs_local_updates WHERE doc_id = ? AND origin = 'local' AND acked = 0 ORDER BY id ASC")
      .all(docId) as Array<{ id: number; bytes: Buffer | Uint8Array; clientUpdateId: string | null }>
    return rows.map((r) => ({
      id: r.id,
      bytes: r.bytes instanceof Buffer ? new Uint8Array(r.bytes) : r.bytes,
      clientUpdateId: r.clientUpdateId,
    }))
  }

  /** All unacked local updates across every doc (used to flush on reconnect). */
  loadAllUnackedLocalUpdates(): Array<{ id: number; docId: string; bytes: Uint8Array; clientUpdateId: string | null }> {
    const rows = this.db
      .prepare("SELECT id, doc_id as docId, bytes, client_update_id as clientUpdateId FROM yjs_local_updates WHERE origin = 'local' AND acked = 0 ORDER BY id ASC")
      .all() as Array<{ id: number; docId: string; bytes: Buffer | Uint8Array; clientUpdateId: string | null }>
    return rows.map((r) => ({
      id: r.id,
      docId: r.docId,
      bytes: r.bytes instanceof Buffer ? new Uint8Array(r.bytes) : r.bytes,
      clientUpdateId: r.clientUpdateId,
    }))
  }

  markYjsUpdateAcked(id: number): void {
    this.db.prepare("UPDATE yjs_local_updates SET acked = 1 WHERE id = ?").run(id)
  }

  /**
   * Backfill a clientUpdateId onto a row that somehow lacks one (e.g. a
   * pre-V7 row that escaped the migration). Used by the reconnect flush so
   * resends always reuse the same id and the server can dedupe.
   */
  setYjsUpdateClientId(id: number, clientUpdateId: string): void {
    this.db.prepare("UPDATE yjs_local_updates SET client_update_id = ? WHERE id = ? AND client_update_id IS NULL").run(clientUpdateId, id)
  }

  /**
   * Retire a local row by its server-echoed clientUpdateId. Called when a
   * `yjsUpdateAck` message arrives from the server. Idempotent — duplicate
   * acks (e.g. a resend that the server had already persisted) silently
   * no-op on an already-acked row.
   */
  markYjsUpdateAckedByClientId(clientUpdateId: string): void {
    this.db.prepare("UPDATE yjs_local_updates SET acked = 1 WHERE client_update_id = ?").run(clientUpdateId)
  }

  /**
   * Replace the snapshot and clear subsumed updates whose id is <= upToId.
   *
   * Preserves rows that are NOT proven durable: `origin='local' AND acked=0`
   * stay in the log so the reconnect flush can still resend them. Without
   * this filter, compaction under churn can silently delete in-flight local
   * edits the server has not yet confirmed.
   *
   * `update_count` is recomputed from the post-delete row count inside the
   * transaction — the caller does not need to estimate it.
   */
  replaceYjsSnapshot(docId: string, snapshot: Uint8Array, upToUpdateId: number): void {
    const buf = Buffer.from(snapshot)
    const now = Date.now()
    this.db.exec("BEGIN")
    try {
      this.db
        .prepare(`
          DELETE FROM yjs_local_updates
          WHERE doc_id = ? AND id <= ? AND (origin = 'remote' OR acked = 1)
        `)
        .run(docId, upToUpdateId)
      const remaining = (this.db
        .prepare("SELECT COUNT(*) as c FROM yjs_local_updates WHERE doc_id = ?")
        .get(docId) as { c: number }).c
      this.db
        .prepare(`
          INSERT INTO yjs_local_state (doc_id, snapshot, update_count, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(doc_id) DO UPDATE SET
            snapshot = excluded.snapshot,
            update_count = excluded.update_count,
            updated_at = excluded.updated_at
        `)
        .run(docId, buf, remaining, now)
      this.db.exec("COMMIT")
    } catch (err) {
      this.db.exec("ROLLBACK")
      throw err
    }
  }

  /** Count of incremental updates for a doc (used by the compactor threshold). */
  yjsUpdateCount(docId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM yjs_local_updates WHERE doc_id = ?")
      .get(docId) as { c: number }
    return row.c
  }

  /** Forget all Yjs persistence for a doc. Used when a file is deleted. */
  purgeYjsForDoc(docId: string): void {
    this.db.prepare("DELETE FROM yjs_local_state WHERE doc_id = ?").run(docId)
    this.db.prepare("DELETE FROM yjs_local_updates WHERE doc_id = ?").run(docId)
  }

  close(): void {
    this.db.close()
  }
}
