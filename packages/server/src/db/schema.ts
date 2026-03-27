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
    deleted: boolean("deleted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("file_entries_workspace_id_idx").on(t.workspaceId),
    // Unique path per workspace for non-deleted files enforced in app logic
  ]
)

// ---- Collaborative docs ----

export const collaborativeDocs = pgTable("collaborative_docs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  fileId: text("file_id").notNull().references(() => fileEntries.id, { onDelete: "cascade" }),
  snapshot: bytea("snapshot"), // latest Yjs snapshot
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
  updateCount: integer("update_count").notNull().default(0),
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
