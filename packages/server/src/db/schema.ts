import { sql } from "drizzle-orm"
import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"

// Re-export change type for use across the server
export type ChangeType = "fileCreated" | "fileRenamed" | "fileDeleted" | "binaryUpdated" | "fileContentChanged" | "workspaceRenamed"

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea"
  },
})

// ---- Users ----

export const users = pgTable("users", {
  id: text("id").primaryKey(), // UUID, generated in app
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// ---- Refresh tokens ----

export const refreshTokens = pgTable("refresh_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  selector: text("selector").notNull().unique(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// ---- Workspaces ----

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull().references(() => users.id),
  revision: integer("revision").notNull().default(0),
  status: text("status", { enum: ["active", "archived", "deleted"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

// ---- Workspace members ----

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "editor", "viewer"] }).notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })]
)

// ---- File entries ----

export const fileEntries = pgTable(
  "file_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind", { enum: ["text", "binary", "folder"] }).notNull(),
    docId: text("doc_id"), // FK -> collaborative_docs, nullable
    binaryHash: text("binary_hash"),
    binarySize: integer("binary_size"),
    /** POSIX mode bits & 0o777, captured by the first peer that uploaded the file. */
    mode: integer("mode"),
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("file_entries_workspace_id_idx").on(t.workspaceId),
    // Case-insensitive uniqueness — prevents pentesters on case-insensitive
    // filesystems (macOS / Windows) from clobbering each other when one creates
    // `Finding.md` and the other `finding.md`.
    uniqueIndex("file_entries_ws_path_ci_idx")
      .on(t.workspaceId, sql`lower(${t.path})`)
      .where(sql`${t.deleted} = false`),
  ]
)

// ---- Collaborative docs ----

export const collaborativeDocs = pgTable("collaborative_docs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  fileId: text("file_id").notNull().references(() => fileEntries.id, { onDelete: "cascade" }),
  snapshot: bytea("snapshot"), // latest Yjs snapshot
  /**
   * Hex-encoded SHA-256 of the snapshot bytes, written atomically with the snapshot itself.
   * On load, the hash is re-computed and compared; a mismatch — or a failure to apply the
   * snapshot as a Yjs update — flips the `corrupted` flag and halts writes for this doc.
   * Null for docs that have no snapshot yet (fresh docs store their state as yjs_updates rows).
   */
  snapshotHash: text("snapshot_hash"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
  updateCount: integer("update_count").notNull().default(0),
  /**
   * Sticky corruption flag. Once set, `loadDoc` and `persistUpdate` refuse to touch the doc
   * so a freshly-created empty Y.Doc cannot silently overwrite the real content. Requires
   * manual intervention (restore from backup or clear the flag) to recover.
   */
  corrupted: boolean("corrupted").notNull().default(false),
  /**
   * Soft-delete timestamp. Set when the owning `file_entry` is deleted. Gives a
   * recovery window (default 30 days, configurable at the job) during which an
   * accidental pentest report deletion can be rolled back by clearing this column.
   * A background job hard-deletes rows whose deletedAt is older than the window —
   * at that point the associated yjs_updates cascade away and the doc is gone for good.
   */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// ---- Yjs updates ----

export const yjsUpdates = pgTable(
  "yjs_updates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    docId: text("doc_id").notNull().references(() => collaborativeDocs.id, { onDelete: "cascade" }),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("yjs_updates_doc_id_idx").on(t.docId)]
)

// ---- Workspace change log ----

export const workspaceChanges = pgTable(
  "workspace_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    type: text("type").notNull().$type<ChangeType>(),
    fileId: text("file_id"),
    path: text("path"),
    oldPath: text("old_path"),
    kind: text("kind"),
    hash: text("hash"),
    size: integer("size"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspace_changes_ws_rev_idx").on(t.workspaceId, t.revision)]
)

// ---- Import sessions ----

export const importSessions = pgTable("import_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  status: text("status", {
    enum: ["in_progress", "committed", "aborted", "expired"],
  }).notNull().default("in_progress"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// ---- Upload sessions (chunked + resumable binary upload) ----

/**
 * Tracks an in-progress chunked binary upload. The actual chunk bytes live on
 * the storage backend under `<SHYNKRO_BLOB_DIR>/.upload-sessions/<id>/<index>.bin`;
 * this row holds the metadata so a client can resume after a reconnect or
 * extension restart, and so the expireUploadSessions job can clean up
 * abandoned sessions safely.
 *
 * Sessions live until their `expiresAt` timestamp passes, at which point both
 * the row and the temp directory are deleted by the periodic job.
 */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => fileEntries.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Total file size in bytes — used for the disk-space pre-flight + sanity check on complete. */
    totalSize: integer("total_size").notNull(),
    chunkSize: integer("chunk_size").notNull(),
    totalChunks: integer("total_chunks").notNull(),
    /** SHA-256 hex of the full file, declared by the client and verified at complete time. */
    expectedSha256: text("expected_sha256").notNull(),
    fileName: text("file_name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("upload_sessions_expires_at_idx").on(t.expiresAt),
    index("upload_sessions_workspace_id_idx").on(t.workspaceId),
  ]
)

// ---- Recent op IDs (idempotency cache for pending_ops replays) ----

/**
 * Remembers the result of recently-processed client ops so a replay — e.g. an
 * extension that crashed between server-applied and client-acked, then drained
 * its pending_ops queue on restart — returns the stored result instead of
 * re-executing the mutation. Prevents double-creates and spurious conflicts.
 *
 * Rows are keyed by the client-generated UUID from the X-Shynkro-Op-Id header.
 * A background job purges rows older than RECENT_OP_ID_TTL_HOURS (24h).
 */
export const recentOpIds = pgTable(
  "recent_op_ids",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    opId: text("op_id").notNull(),
    /** The HTTP status and JSON body of the original response, stored verbatim. */
    result: text("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.opId] }),
    index("recent_op_ids_created_at_idx").on(t.createdAt),
  ]
)

// ---- Staged import files (part of an import session) ----

export const importFiles = pgTable(
  "import_files",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().references(() => importSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    kind: text("kind", { enum: ["text", "binary", "folder"] }).notNull(),
    content: text("content"), // plain text or base64
    hash: text("hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("import_files_session_path_idx").on(t.sessionId, t.path),
  ]
)
