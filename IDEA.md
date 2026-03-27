# Shynkro — Collaborative Workspace for VS Code

This document is the detailed technical specification for the Shynkro collaborative workspace system for VS Code.

## 1. Overview

Shynkro is a **persistent, server-authoritative collaborative workspace system** for VS Code and compatible forks. It synchronizes local folders with a central server, enabling real-time collaborative text editing (via Yjs) and managed binary file sync. No user hosts a session; the server is always the authority.

It allows users to:

- initialize an existing local folder as a shared workspace,
- clone an existing shared workspace from a server,
- open a local mirrored workspace and automatically reconnect,
- collaboratively edit text files in real time,
- synchronize all other files through the same workspace model,
- keep local rendering/tooling workflows, especially for Typst.

The system is designed so that:

- **the folder is the workspace**,
- **the server is the permanent authority**,
- **no user hosts a session**,
- **local folders are synchronized mirrors**,
- **the extension bridges local editing and server-backed collaboration**.

---

## 2. Goals

## 2.1 Primary goals

- Provide a **server-backed collaborative workspace** model.
- Allow a user to **initialize the currently opened local folder** as a collaborative workspace.
- Allow other users to **clone or open** that workspace locally.
- Automatically reconnect when a folder containing `.shynkro/` is opened.
- Support **real-time collaborative editing** for text-like files.
- Support **synchronized binary files** like images and assets.
- Keep **local file copies** so local Typst rendering works naturally.
- Avoid any **host/guest session model**.

## 2.2 Secondary goals

- Support workspace permissions and authentication.
- Support basic presence information.
- Support file and folder operations across clients.
- Provide a path toward compatibility with VS Code forks.

## 2.3 Non-goals for MVP

- Full offline editing with eventual conflict UI
- Browser-only client
- Fine-grained access control per file
- Simultaneous binary merge editing
- Rich comments/review system
- Built-in version history UI
- Git replacement

---

## 3. Core concepts

| Concept                     | Definition                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace**               | A collaborative project. Server-side entity with a unique ID.                                                                                                                 |
| **Local mirror**            | A user's local folder synchronized with the workspace.                                                                                                                        |
| **Server workspace**        | The authoritative representation: file tree, content, permissions.                                                                                                            |
| **Collaborative text file** | A text file backed by a Yjs document for live concurrent editing.                                                                                                             |
| **Managed binary file**     | A binary file synchronized as a whole unit (no byte-level collaboration).                                                                                                     |
| **Workspace revision**      | A monotonically increasing counter on the server, incremented on every structural change (file create/rename/delete, permission change). Used for incremental reconciliation. |

---

## 4. High-level architecture

## 4.1 Components

### A. Backend server
Responsibilities:

- authentication
- workspace registry
- file tree metadata
- content storage
- Yjs sync service
- persistence
- broadcasting file tree changes
- presence tracking

### B. VS Code extension
Responsibilities:

- initialize/open/clone workspaces
- detect `.shynkro/`
- connect to backend
- sync workspace state
- integrate collaborative text editing
- manage local mirrored files
- manage binary sync
- handle file tree operations
- expose commands/UI

### C. Local workspace folder
Contains:

- user-visible project files
- hidden `.shynkro/` metadata
- SQLite state database

## 4.2 Backend technology decisions

| Concern         | Decision                                                         | Rationale                                                                               |
| --------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Metadata DB     | **PostgreSQL**                                                   | Concurrent writes, ACID, mature. SQLite is unsuitable for multi-user server.            |
| Binary storage  | **Plain filesystem, content-addressable** for MVP; MinIO/S3 adapter in Phase 3 | Path = `blobs/{sha256[0:2]}/{sha256[2:4]}/{sha256}`. Zero extra dependency for self-hosted MVP. See section 4.4. |
| Yjs persistence | **PostgreSQL** (updates table) + periodic snapshots              | Updates appended as rows. Snapshot replaces accumulated updates when threshold reached. |
| Server runtime  | **Node.js / TypeScript**                                         | Shares Yjs ecosystem natively.                                                          |
| Deployment      | **Single-instance for MVP**                                      | Yjs sync requires in-memory document state. Horizontal scaling deferred to Phase 4.     |

## 4.3 WebSocket framing

The single WebSocket carries multiplexed message types with unambiguous framing:

- **Binary frames**: Yjs sync protocol only (updates, state vectors). High-frequency; never parsed as JSON.
- **Text frames**: JSON-encoded messages for file tree events, awareness, heartbeat, control messages.

## 4.4 Storage backend

Binary blob storage is abstracted behind a `StorageBackend` interface from day one, so the underlying implementation can be swapped without touching the rest of the codebase.

### Interface contract

```typescript
interface StorageBackend {
  put(hash: string, stream: Readable): Promise<void>
  get(hash: string): Promise<Readable>
  exists(hash: string): Promise<boolean>
  delete(hash: string): Promise<void>
}
```

### MVP: plain filesystem

Implementation: `FilesystemStorageBackend`

- Blobs stored at `{BLOB_ROOT}/ab/cd/abcdef...` (content-addressable, first 2 and next 2 hex chars as directory shards).
- `BLOB_ROOT` is configured via environment variable (e.g. `SHYNKRO_BLOB_DIR=/var/shynkro/blobs`).
- No extra service required — works out of the box for self-hosted deployments.
- Deduplication is free: identical content has the same hash and occupies one file regardless of how many workspace files reference it.
- Backup strategy: rsync or snapshot `BLOB_ROOT` alongside a PostgreSQL dump.

### Phase 3: MinIO / S3 adapter

Implementation: `S3StorageBackend`

- Implements the same `StorageBackend` interface.
- Configured with standard S3 environment variables (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`).
- Compatible with MinIO (self-hosted), AWS S3, Cloudflare R2, Backblaze B2 — any S3-compatible endpoint.
- Enables horizontal server scaling (blobs no longer tied to one machine's disk).
- Presigned URL support can be added later to allow clients to upload/download directly without proxying through the app server.

### Selection

The active backend is selected at startup from environment configuration:

```
SHYNKRO_STORAGE=filesystem   # default
SHYNKRO_STORAGE=s3
```

---

## 5. Protocol and versioning

## 5.1 API versioning

All REST endpoints are prefixed with `/api/v1/`. Breaking changes require a new version prefix.

## 5.2 WebSocket protocol versioning

The `hello` message includes a `protocolVersion` field. Server responds with its own version. If incompatible, server sends `{ "type": "error", "code": "PROTOCOL_MISMATCH" }` and closes the connection.

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "extensionVersion": "0.1.0",
  "token": "..."
}
```

## 5.3 Extension-server compatibility check

On activation, the extension calls `GET /api/v1/health`. Server returns:

```json
{ "status": "ok", "apiVersion": 1, "minExtensionVersion": "0.1.0" }
```

If the extension version is below `minExtensionVersion`, it shows an "update required" notification and refuses to connect.

---

## 6. Workspace lifecycle

## 6.1 Initialize current folder

A user opens an existing local folder and converts it into a collaborative workspace.

### Preconditions
- Folder is open in VS Code.
- Folder does **not** contain `.shynkro/project.json` (guard against double-init).
- User is authenticated.

### Flow
1. User runs `Shynkro: Initialize Workspace`.
2. Extension checks for existing `.shynkro/` — if found, abort with message.
3. Extension authenticates (or prompts login).
4. Extension calls `POST /api/v1/workspaces` to create workspace. Server returns `workspaceId`.
5. Extension scans local folder (respecting `.shynkroignore` rules).
6. Extension begins **transactional import**:
   - `POST /api/v1/workspaces/{id}/import/begin` — server creates import session, returns `importId`.
   - For each file: `POST /api/v1/workspaces/{id}/import/{importId}/files` (idempotent, keyed by path).
   - `POST /api/v1/workspaces/{id}/import/{importId}/commit` — server atomically publishes the workspace.
   - On failure: `POST /api/v1/workspaces/{id}/import/{importId}/abort` — server cleans up.
7. **Only after successful commit**: Extension writes `.shynkro/` metadata.
8. Extension opens WebSocket, starts sync.
9. Folder becomes a managed workspace.

### Failure recovery

| Failure point                | Recovery                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Network loss during upload   | Extension retries. Import session has server-side TTL (30 min). File uploads are idempotent. |
| VS Code closed during import | No `.shynkro/` written yet. Orphaned session expires on server. User re-runs init.           |
| Server crash during import   | Session not committed, workspace has no files. Server cleanup job removes expired sessions.  |
| Commit fails permanently     | Extension calls abort. Notifies user.                                                        |

---

## 6.2 Clone existing workspace

A user downloads an existing workspace from the server into a local directory.

### Flow
1. User runs `Shynkro: Clone Workspace`.
2. Extension authenticates.
3. Extension fetches `GET /api/v1/workspaces` — user picks one.
4. User selects empty local folder (extension validates emptiness or prompts confirmation).
5. Extension calls `GET /api/v1/workspaces/{id}/snapshot` — server returns:
   ```json
   {
     "revision": 57,
     "files": [
       { "fileId": "f_1", "path": "main.typ", "kind": "text", "size": 1240, "hash": "abc123" },
       { "fileId": "f_2", "path": "assets/logo.png", "kind": "binary", "size": 204800, "hash": "def456" }
     ]
   }
   ```
6. Extension writes `.shynkro/.clone-in-progress` immediately.
7. Extension downloads files (max 4 parallel downloads).
   - Text files: download current plain-text content derived from Yjs state.
   - Binary files: download blob.
8. Extension writes `.shynkro/` metadata with `lastWorkspaceRevision` from snapshot.
9. Extension removes `.clone-in-progress`.
10. Extension opens WebSocket, starts sync.

### Partial clone recovery

If clone fails midway, `.clone-in-progress` remains. On next activation, extension detects it, offers to resume or clean up the incomplete folder.

---

## 6.3 Open existing local workspace

A user opens a folder containing `.shynkro/`.

### Flow
1. VS Code opens folder.
2. Extension activates, detects `.shynkro/project.json`.
3. Extension validates `project.json` schema and workspace ID format.
4. Extension calls `GET /api/v1/health` — checks server reachability and version compatibility.
5. Extension authenticates (token from secret storage, refresh if needed).
6. Extension calls `GET /api/v1/workspaces/{id}`:
   - `404`: Workspace deleted. Show notification: "This workspace no longer exists on the server. Disconnect?" Offer to remove `.shynkro/` while keeping local files.
   - `403`: Permissions revoked. Show notification.
7. Extension runs reconciliation (see section 11.1).
8. Extension opens WebSocket, starts sync.

---

## 6.4 Ignore rules

The extension respects a `.shynkroignore` file (gitignore syntax) at the workspace root. Defaults always included:

```
.shynkro/
.git/
node_modules/
__pycache__/
.DS_Store
Thumbs.db
```

Files matching ignore rules are never synced, uploaded, or tracked.

On initialization, the extension automatically appends `.shynkro/` to `.gitignore` if a `.git/` directory exists.

---

## 7. Local workspace layout

## 7.1 Required structure

```text
workspace-root/
  .shynkro/
    project.json            # Workspace identity (safe to commit, no secrets)
    state.db                # SQLite: file mappings, sync state, operation queue
    .clone-in-progress      # Temp: only present during incomplete clone
  .shynkroignore
  main.typ
  appendix.typ
  assets/
    logo.png
```

## 7.2 Why SQLite from day one

A flat `files.json` does not scale. Every file operation requires reading, parsing, modifying, and atomically rewriting the entire file. With 200+ files this becomes a bottleneck. SQLite provides:
- Atomic transactions.
- Indexed lookups by path or file ID.
- Safe concurrent reads.
- No full-file rewrite on every change.

### `state.db` schema

```sql
CREATE TABLE file_entries (
  file_id     TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK(kind IN ('text', 'binary', 'folder')),
  doc_id      TEXT,
  local_hash  TEXT,
  server_hash TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
  -- Keys: 'lastWorkspaceRevision', 'lastSyncAt'
);

CREATE TABLE operation_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  op_type    TEXT NOT NULL,
  payload    TEXT NOT NULL,   -- JSON
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  retries    INTEGER NOT NULL DEFAULT 0
);
```

## 7.3 `.shynkro/project.json`

```json
{
  "workspaceId": "ws_abc123",
  "serverUrl": "https://shynkro.example.com",
  "protocolVersion": 1,
  "displayName": "Acme Audit 2026",
  "createdAt": "2026-03-24T10:00:00Z"
}
```

This file is safe to commit to git (no secrets). If `project.json` exists but `state.db` is missing or deleted, the extension offers to re-sync the workspace from server using the `workspaceId`.

## 7.4 `.shynkro/` protection

- On init, extension appends `.shynkro/` to `.gitignore` if `.git/` exists (state.db should not be committed).
- Extension watches for `.shynkro/` deletion. If detected while connected, shows prominent warning: "Workspace metadata was deleted. Re-link workspace to restore?"
- The `Shynkro: Re-link Workspace` command rebuilds `state.db` from server state using only the `workspaceId` in `project.json`.

---

## 8. Content model

## 8.1 File classification

Classification is determined by extension:

| Extension | Kind |
|-----------|------|
| `.typ`, `.md`, `.txt`, `.tex` | text |
| `.json`, `.yaml`, `.toml` | text |
| `.js`, `.ts`, `.py`, `.rs`, and other code files | text |
| `.png`, `.jpg`, `.pdf`, `.woff`, `.ttf`, archives | binary |
| Unknown / no extension | binary |

Classification is stored per-file in `state.db` and can be overridden manually.

## 8.2 Special file handling

- **Symlinks**: Resolved and treated as regular files. Symlink targets outside the workspace root are ignored with a warning.
- **Hardlinks**: Treated as independent files.
- **Empty files**: Tracked normally as text with an empty Yjs doc.
- **Empty folders**: Tracked explicitly as `kind: 'folder'` entries. Server creates folder entries. Clients create empty directories on sync.
- **Dotfiles**: Tracked unless excluded by ignore rules.
- **Encoding**: All collaborative text files are assumed UTF-8. Non-UTF-8 files detected on import are classified as binary with a user notification.

## 8.3 Source of truth

| Entity              | Authority                                        |
| ------------------- | ------------------------------------------------ |
| Text file content   | Yjs document state on server                     |
| Binary file content | Server blob storage                              |
| File tree structure | Server metadata (workspace revision)             |
| Local files         | Derived mirror — always reconcilable from server |

---

## 9. Server data model

## 9.1 Entities

```sql
User
  id              UUID PK
  email           TEXT UNIQUE NOT NULL
  display_name    TEXT NOT NULL
  password_hash   TEXT NOT NULL
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ

Workspace
  id              UUID PK
  name            TEXT NOT NULL
  owner_id        UUID FK -> User
  revision        BIGINT NOT NULL DEFAULT 0
  status          TEXT NOT NULL DEFAULT 'active'  -- active, archived, deleted
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ

WorkspaceMember
  workspace_id    UUID FK -> Workspace
  user_id         UUID FK -> User
  role            TEXT NOT NULL  -- owner, editor, viewer
  invited_at      TIMESTAMPTZ
  accepted_at     TIMESTAMPTZ
  PRIMARY KEY (workspace_id, user_id)

FileEntry
  id              UUID PK
  workspace_id    UUID FK -> Workspace
  path            TEXT NOT NULL
  kind            TEXT NOT NULL  -- text, binary, folder
  doc_id          UUID NULLABLE FK -> CollaborativeDoc
  binary_hash     TEXT NULLABLE
  binary_size     BIGINT NULLABLE
  deleted         BOOLEAN DEFAULT FALSE
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
  UNIQUE (workspace_id, path) WHERE deleted = FALSE

CollaborativeDoc
  id              UUID PK
  workspace_id    UUID FK -> Workspace
  file_id         UUID FK -> FileEntry
  snapshot        BYTEA NULLABLE
  snapshot_at     TIMESTAMPTZ NULLABLE
  update_count    INTEGER NOT NULL DEFAULT 0
  created_at      TIMESTAMPTZ

YjsUpdate
  id              BIGSERIAL PK
  doc_id          UUID FK -> CollaborativeDoc
  data            BYTEA NOT NULL
  created_at      TIMESTAMPTZ

ImportSession
  id              UUID PK
  workspace_id    UUID FK -> Workspace
  user_id         UUID FK -> User
  status          TEXT NOT NULL  -- in_progress, committed, aborted, expired
  expires_at      TIMESTAMPTZ NOT NULL
  created_at      TIMESTAMPTZ
```

## 9.2 Yjs persistence and compaction

Strategy: append-only updates with periodic snapshotting.

1. Every Yjs update from a client is appended to `YjsUpdate`.
2. When `update_count` exceeds **500** (configurable), the server:
   - Loads all updates + current snapshot into a Yjs Doc.
   - Encodes a new snapshot (`Y.encodeStateAsUpdate(doc)`).
   - In a transaction: writes new snapshot, deletes old updates, resets counter.
3. On doc load: apply snapshot, then replay updates since snapshot.

**Corruption handling**: If applying updates throws, the server:
- Logs the error.
- Falls back to snapshot only (losing only recent updates).
- If snapshot is also corrupt, falls back to empty doc and logs a critical alert.
- Sends a `docReset` message to connected clients.

---

## 10. Backend responsibilities

## 10.1 Authentication service

Must provide:
- register
- login
- token refresh
- current user identity
- access validation

Token model:
- **Access token**: JWT, 15-minute expiry. Contains `userId`, `exp`.
- **Refresh token**: Opaque, stored server-side, 30-day expiry. Single-use (rotation on refresh).

---

## 10.2 Workspace service

Must support:
- create workspace
- transactional import (begin/upload/commit/abort)
- list accessible workspaces
- get workspace metadata
- update workspace name/settings
- delete/archive workspace
- export workspace as archive
- change log since revision

---

## 10.3 Member service

Must support:
- list members
- invite by email
- change member role
- remove member
- transfer ownership

---

## 10.4 File tree service

Must support:
- list files / get full tree
- create file or folder
- rename/move
- delete (soft delete with `deleted` flag)
- restore
- publish file tree change events

All mutation endpoints accept `X-Expected-Revision` header. Server rejects mutations with `409 Conflict` if the revision has advanced and the operation conflicts.

---

## 10.5 Content service

### For text files
Must support:
- create Yjs-backed document
- load persisted doc (snapshot + updates)
- append Yjs update
- snapshot/compact doc
- serve plain-text content derived from Yjs state

### For binary files
Must support:
- upload blob (streaming)
- download blob (streaming)
- replace blob
- track content hashes
- content-addressable deduplication

---

## 10.6 Realtime service

Must support:
- WebSocket connection with protocol version negotiation
- Yjs update relay (binary frames)
- awareness/presence relay
- file tree event broadcast
- permission change events
- workspace lifecycle events (deletion, archival)
- token expiry notifications
- heartbeat/ping-pong
- back-pressure signaling

---

## 10.7 Persistence

Must persist:
- workspace metadata
- file tree (with soft deletes)
- binary data (content-addressable)
- Yjs state (updates + snapshots)
- permissions
- import sessions (with TTL)

---

## 11. Sync engine

## 11.1 Reconciliation on connect

When the extension connects (open or reconnect):

1. Read `lastWorkspaceRevision` from local `state.db`.
2. Call `GET /api/v1/workspaces/{id}/changes?since={revision}`.
3. Server returns a list of changes since that revision:
   ```json
   {
     "currentRevision": 57,
     "changes": [
       { "revision": 43, "type": "fileCreated", "fileId": "f_5", "path": "notes.md", "kind": "text" },
       { "revision": 44, "type": "fileDeleted", "fileId": "f_3", "path": "old.typ" },
       { "revision": 45, "type": "fileRenamed", "fileId": "f_1", "path": "chapter1.typ", "oldPath": "intro.typ" },
       { "revision": 50, "type": "binaryUpdated", "fileId": "f_2", "hash": "newHash", "size": 51200 }
     ]
   }
   ```
4. Extension applies uncontested changes to local mirror sequentially:
   - Files changed only on server and not locally: apply server version.
   - Files changed only locally: push local version to server.
   - Files changed on **both** sides (local hash ≠ `server_hash` stored at last sync): flag as a **reconnect conflict** (see section 11.7).
5. Updates `lastWorkspaceRevision` in `state.db`.

If `lastWorkspaceRevision` is too old (server has compacted its change log), the server returns `410 Gone`. The client fetches a full snapshot and diffs against local state, applying the same conflict detection logic.

## 11.7 Reconnect conflict resolution

When a file has been modified both locally and on the server since the last successful sync, the extension opens a **conflict resolution panel** for that file.

### For binary files

The panel shows:

```
Conflict: assets/logo.png

  [Your version]           [Server version]
  Modified: 2026-03-25     Modified: 2026-03-24
  Size: 204 KB             Size: 198 KB

  [Keep mine]              [Keep server's]
```

The user picks one version. The chosen version becomes the new server state and overwrites the other. No merge is attempted.

### For text files (externally edited while disconnected)

If a collaborative text file was edited on disk while the extension was disconnected (bypassing Yjs), the panel shows a **diff view** similar to a git merge conflict:

```
Conflict: chapter1.typ

  Your changes   |   Server version
  ───────────────|───────────────────
  - old line     |   unchanged line
  + new line     |   server's line
                 |   server's addition

  [Keep mine]    [Keep server's]
```

The user picks one version in full. Line-by-line merging is out of scope for MVP.

If the extension was connected throughout (normal editing via VS Code), text conflicts never arise — Yjs resolves them automatically.

### Conflict list

If multiple files conflict on reconnect, the extension shows a consolidated list in the Shynkro sidebar:

```
⚠ 3 conflicts detected after reconnect
  • assets/logo.png      [binary]
  • chapter1.typ         [text — external edit]
  • data/config.json     [text — external edit]
```

Each entry opens its conflict panel. Sync resumes fully only after all conflicts are resolved or explicitly dismissed (dismiss = keep server version).

## 11.2 Local file watching and write-tagging

The extension uses VS Code's `FileSystemWatcher` and maintains a **write-tag set**:

```
writeTagSet: Set<string>  // paths currently being written by the extension

Before writing a file:
  1. Add path to writeTagSet.
  2. Write to temp file, then rename (atomic write).
  3. After the fs event fires for this path, remove from writeTagSet.

On any fs event:
  if path in writeTagSet: ignore (our own write).
  else: classify as external change, process accordingly.
```

This prevents sync loops. Atomic writes (temp + rename) prevent partial-write corruption.

## 11.3 Continuous sync

| Event                                | Action                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Local text edit in VS Code           | Convert to Yjs op, send via WebSocket. Do NOT write to disk immediately (Yjs state is authoritative). |
| Remote Yjs update received           | Apply to local Yjs doc. Write updated content to disk (atomic).                                       |
| Local binary file changed (external) | Compute hash. If different from `server_hash`, upload new version.                                    |
| Remote binary update event           | Download new blob. Write to disk (atomic). Update local hash.                                         |
| Local file created                   | Determine kind. Call create API. Server assigns IDs. Update `state.db`.                               |
| Remote file created                  | Create local file. Download content.                                                                  |
| Local file deleted                   | Call delete API.                                                                                      |
| Remote file deleted                  | Delete local file. If file is open in editor, show notification and close or mark read-only.          |
| Local file renamed                   | Call rename API with `fileId` and new path.                                                           |
| Remote file renamed                  | Rename local file. Update `state.db` path.                                                            |

## 11.4 Concurrent file tree mutations

All file tree mutations on the server acquire a per-workspace lock. Operations are serialized.

| Scenario                                 | Server behavior                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Two users rename the same file           | First wins. Second receives `409 Conflict`. Client re-fetches and retries or notifies user. |
| User A deletes, User B renames same file | First wins. Second receives `404` or `409`.                                                 |
| Two users create file at the same path   | First wins. Second receives `409 Conflict (path exists)`. Client notifies user.             |

All mutation requests include `expectedRevision`. Non-conflicting concurrent operations (different paths) proceed even with slightly stale revisions.

## 11.5 Operation queue

When offline or during transient failures, operations are queued in `state.db.operation_queue`. On reconnect:

1. Replay queued operations in order.
2. On `409 Conflict`, notify user and offer resolution or discard.
3. Clear successfully executed operations.

## 11.6 Reconnect behavior

1. On WebSocket disconnect: show "Disconnected" in status bar.
2. Retry with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap).
3. On reconnect: run full reconciliation.
4. Re-subscribe to all currently open Yjs documents.
5. Re-announce awareness state.

---

## 12. Extension responsibilities

## 12.1 Activation

On startup or folder open, the extension must:
- inspect workspace folders
- detect `.shynkro/project.json`
- validate schema and server compatibility
- authenticate if needed
- offer reconnect/status UI

---

## 12.2 Commands

Required commands:

- `Shynkro: Initialize Workspace`
- `Shynkro: Clone Workspace`
- `Shynkro: Connect Workspace`
- `Shynkro: Disconnect Workspace`
- `Shynkro: Show Workspace Status`
- `Shynkro: Reconnect Workspace`
- `Shynkro: Re-link Workspace` — rebuilds state.db from server
- `Shynkro: Resolve Sync Issues` (Phase 2)
- `Shynkro: Share Workspace` (Phase 2)

---

## 12.3 Workspace sync engine

The extension must:
- maintain connection to backend
- reconcile local state with server state on connect
- apply remote changes to local files (atomic writes)
- propagate local file operations to server
- tag own writes to avoid sync loops
- queue operations when offline

---

## 12.4 Collaborative text integration

The extension must:
- identify collaborative text files by kind stored in `state.db`
- connect opened text files to Yjs
- apply local VS Code edits to Yjs Y.Text
- apply remote Yjs updates to editor buffer and disk
- update local mirror file safely (atomic write + write-tag)

For files **not open in an editor**: handle `fileContentChanged` events by downloading updated plain-text content and writing to disk, without loading a full Yjs doc in memory.

---

## 12.5 Binary sync integration

The extension must:
- watch binary file additions/deletions/updates
- compute SHA-256 hash before upload; skip if unchanged
- upload with max 2 concurrent transfers; queue remainder
- download remote binary updates and write atomically

---

## 12.6 Multi-instance protection

The extension uses a lock file at `.shynkro/.lock` containing the PID and a random nonce.

1. On activation, attempt to create `.shynkro/.lock`.
2. If it exists, check if the PID is still alive.
3. If alive: another VS Code window is syncing. Enter **read-only mode** with a notification.
4. If dead: stale lock. Overwrite.

A user with the same workspace open on two different machines is valid and supported. Both machines are mirrors; they converge naturally via server state.

---

## 12.7 Status and notifications

The extension should surface:
- connected/disconnected/syncing status in the status bar
- remote user presence (sidebar)
- file sync errors
- auth expiration
- permission changes
- conflict warnings
- workspace deletion events

---

## 13. File operation model

## 13.1 Create file

When a user creates a new file:

- extension detects creation
- determines kind (see section 8.1)
- calls `POST /api/v1/workspaces/{id}/files`
- server allocates `fileId`; if text, creates Yjs doc
- server increments workspace revision
- all clients receive `fileCreated` event and update local state

## 13.2 Rename/move file

When a user renames a file:

- extension calls `PATCH /api/v1/workspaces/{id}/files/{fileId}` with new path and `expectedRevision`
- server updates path, increments revision
- all clients receive `fileRenamed` event and update path mappings
- `fileId` and `docId` remain stable across path changes

## 13.3 Delete file

When a user deletes a file:

- extension calls `DELETE /api/v1/workspaces/{id}/files/{fileId}`
- server soft-deletes the entry, increments revision
- all clients receive `fileDeleted` event
- remote clients delete local file
- if file is open in an editor: show notification, close or mark read-only

---

## 14. Collaborative editing model

## 14.1 One Yjs doc per file

Each collaborative text file corresponds to exactly one Yjs document containing a single `Y.Text` instance. This ensures:
- independent loading
- better scaling
- simpler editor lifecycle

## 14.2 Join behavior

Opening a collaborative file:
- look up `doc_id` in `state.db`
- send `subscribeDoc` via WebSocket
- server sends Yjs state (snapshot + pending updates)
- extension creates local Yjs `Doc`, applies server state
- bridge VS Code editor buffer with Yjs Y.Text

## 14.3 Leave behavior

Closing a file:
- detach editor-level listeners
- send `unsubscribeDoc`
- update awareness state (remove cursor)

## 14.4 Yjs update batching

- Client-side: Yjs updates are batched with a **50ms debounce** before sending.
- Server-side: If a client sends more than 100 updates/second, the server sends a `backPressure` warning. The client increases its batch interval.

---

## 15. Local direct-edit policy

## 15.1 For collaborative text files

When the file watcher detects an external edit (not from the extension):

1. Compute diff between Yjs state and disk content.
2. If diff is small (< 100 lines): import diff as Yjs operations (handles formatters, save-on-format).
3. If diff is large: show warning: "File `{path}` was modified outside VS Code. Import changes or revert to collaborative state?"

Mass external change detection: if 20+ files change within 2 seconds (e.g. `git checkout`), pause sync and ask the user to confirm reconciliation before proceeding.

## 15.2 For binary files

External changes are always accepted:
- detect file replacement
- compute hash
- upload new version

---

## 16. Authentication

## 16.1 Token model

- **Access token**: JWT, 15-minute expiry.
- **Refresh token**: Opaque, server-side, 30-day expiry. Single-use with rotation.

Tokens are stored exclusively in VS Code `SecretStorage`. Never written to `.shynkro/` or any disk file.

## 16.2 Token refresh strategy

The extension implements a **token refresh mutex**:

- On 401 response: acquire mutex. If another caller already refreshed, just retry with the new token.
- If first to reach mutex: call refresh endpoint, update stored tokens, release mutex.
- Queued callers retry with the new token after mutex release.
- **Proactive refresh**: if access token expires in less than 2 minutes, refresh before starting the request.
- For long operations (large imports, bulk uploads): refresh proactively if less than 5 minutes remain before each individual request.

## 16.3 WebSocket authentication

- The `hello` message includes the access token (never in the URL, to avoid log leaks).
- Server sends `tokenExpiring` event 60 seconds before expiry.
- Client responds with `refreshToken` message containing a new access token.
- If the client fails to refresh within that window, the server closes the connection with code `4001 (Auth Expired)`.

---

## 17. Permission model

## 17.1 Roles

| Role   | View | Edit text | Upload binary | Create/delete files | Manage members | Delete workspace |
| ------ | ---- | --------- | ------------- | ------------------- | -------------- | ---------------- |
| viewer | Yes  | No        | No            | No                  | No             | No               |
| editor | Yes  | Yes       | Yes           | Yes                 | No             | No               |
| owner  | Yes  | Yes       | Yes           | Yes                 | Yes            | Yes              |

## 17.2 Live permission changes

When a user's role changes while connected:

1. Server sends `permissionChanged` message: `{ "type": "permissionChanged", "role": "viewer" }`.
2. If downgraded to viewer: pending writes are rejected, Yjs subscriptions switch to read-only, editing commands disabled, user notified.
3. If removed: server sends `memberRemoved`, closes WebSocket with code `4003 (Removed)`. Extension shows notification. Local files remain.

## 17.3 Workspace deletion

1. Server sets workspace status to `deleted`.
2. Server broadcasts `workspaceDeleted` to all connected clients.
3. Server closes all WebSocket connections for that workspace.
4. Clients show notification: "This workspace has been deleted by its owner."
5. Clients enter disconnected state. Local files and `.shynkro/` remain.

---

## 18. Awareness and presence

## 18.1 Two levels of presence

**Workspace-level presence**: "User X is online." Managed via WebSocket connection state. Server tracks connected users per workspace. Broadcasts `presenceUpdate` events.

**Document-level awareness**: "User X's cursor is at line 5 in `main.typ`." Managed via Yjs awareness protocol. Ephemeral.

## 18.2 Ghost cursor prevention

- Yjs awareness entries have a **30-second TTL** enforced by the server.
- If no heartbeat received from a client for 30 seconds, the server removes that user from workspace-level presence and triggers awareness cleanup for their document sessions.

---

## 19. Typst / local rendering

## 19.1 Requirement

PDF rendering must happen locally on each client.

## 19.2 Mirror consistency

The local workspace mirror must remain consistent enough for:
- Typst watch mode
- local preview tools
- file includes/imports
- asset references

The extension targets writing updated disk content within **200ms** of receiving a Yjs update.

## 19.3 Environment configuration (Phase 2)

A `.shynkro/environment.json` can specify:
```json
{
  "typst": { "version": "0.13.0" },
  "fonts": ["assets/fonts/"],
  "ignorePaths": ["build/"]
}
```

Informational in Phase 1; enforced in Phase 2.

---

## 20. API specification

## 20.1 Authentication

```
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
GET  /api/v1/auth/me
```

## 20.2 Health

```
GET  /api/v1/health
```

Response: `{ "status": "ok", "apiVersion": 1, "minExtensionVersion": "0.1.0" }`

## 20.3 Workspaces

```
POST   /api/v1/workspaces
GET    /api/v1/workspaces
GET    /api/v1/workspaces/{id}
PATCH  /api/v1/workspaces/{id}
DELETE /api/v1/workspaces/{id}
GET    /api/v1/workspaces/{id}/changes?since={rev}
GET    /api/v1/workspaces/{id}/export
```

## 20.4 Members

```
GET    /api/v1/workspaces/{id}/members
POST   /api/v1/workspaces/{id}/members
PATCH  /api/v1/workspaces/{id}/members/{userId}
DELETE /api/v1/workspaces/{id}/members/{userId}
POST   /api/v1/workspaces/{id}/transfer
```

## 20.5 Import

```
POST /api/v1/workspaces/{id}/import/begin
POST /api/v1/workspaces/{id}/import/{importId}/files
POST /api/v1/workspaces/{id}/import/{importId}/commit
POST /api/v1/workspaces/{id}/import/{importId}/abort
```

## 20.6 Clone / snapshot

```
GET /api/v1/workspaces/{id}/snapshot
GET /api/v1/workspaces/{id}/tree
GET /api/v1/workspaces/{id}/files/{fileId}/content
```

## 20.7 File tree

```
POST   /api/v1/workspaces/{id}/files
PATCH  /api/v1/workspaces/{id}/files/{fileId}
DELETE /api/v1/workspaces/{id}/files/{fileId}
GET    /api/v1/workspaces/{id}/files/{fileId}
```

All mutation endpoints accept `X-Expected-Revision` header for conflict detection.

## 20.8 Binary blobs

```
PUT /api/v1/workspaces/{id}/files/{fileId}/blob
GET /api/v1/workspaces/{id}/files/{fileId}/blob
```

## 20.9 Realtime

```
GET /api/v1/realtime    (WebSocket upgrade)
```

---

## 21. WebSocket protocol

## 21.1 Message types

**Client → Server (text frames)**:
```
hello                 { protocolVersion, extensionVersion, token }
refreshToken          { token }
subscribeWorkspace    { workspaceId }
subscribeDoc          { workspaceId, docId }
unsubscribeDoc        { docId }
awarenessUpdate       { docId, data }  -- base64-encoded Yjs awareness
ping                  {}
```

**Client → Server (binary frames)**:
```
[1 byte: 0x01 = yjs_update][16 bytes: docId UUID][N bytes: Yjs update data]
```

**Server → Client (text frames)**:
```
welcome               { userId, protocolVersion }
error                 { code, message }
tokenExpiring         { expiresIn }
fileCreated           { workspaceId, fileId, path, kind, revision }
fileRenamed           { workspaceId, fileId, path, oldPath, revision }
fileDeleted           { workspaceId, fileId, path, revision }
binaryUpdated         { workspaceId, fileId, hash, size, revision }
fileContentChanged    { workspaceId, fileId, path }
presenceUpdate        { workspaceId, users: [...] }
permissionChanged     { workspaceId, role }
memberRemoved         { workspaceId }
workspaceDeleted      { workspaceId }
docSubscribed         { docId }
docReset              { docId }
backPressure          { docId, message }
pong                  {}
```

**Server → Client (binary frames)**:
```
[1 byte: 0x01 = yjs_update][16 bytes: docId UUID][N bytes: Yjs update data]
[1 byte: 0x02 = yjs_state ][16 bytes: docId UUID][N bytes: Yjs full state]
[1 byte: 0x03 = awareness  ][16 bytes: docId UUID][N bytes: awareness data]
```

## 21.2 Heartbeat

Client sends `ping` every 30 seconds. Server responds with `pong`. If either side receives no message for 90 seconds, the connection is considered dead and the client triggers reconnect.

---

## 22. Conflict and consistency rules

## 22.1 Text files

Concurrent edits are resolved by Yjs (CRDT). No user action required.

## 22.2 Binary files

**While connected**: uploads are atomic and not visible until complete. If two users upload different versions of the same binary file in quick succession, both uploads succeed and the last one wins — other clients are notified and receive the latest version.

**On reconnect after offline period**: if both the local file and the server file changed since last sync, the extension presents the reconnect conflict panel (section 11.7). The user picks which version to keep. No automatic merge.

## 22.3 File tree operations

Server serializes structural updates using per-workspace lock. Conflicting mutations return `409 Conflict`. Clients reconcile via the change log.

---

## 23. Security requirements

- All server communication over HTTPS/WSS.
- Tokens stored in VS Code `SecretStorage` only. Never in `.shynkro/` or on disk.
- WebSocket auth via `hello` message body (not URL parameters, which leak to logs).
- Permission checks on all workspace/file endpoints.
- Validate workspace membership on all realtime subscriptions.
- Sanitize paths on server: reject `..`, absolute paths, null bytes, and path traversal attempts.
- Rate limiting:

| Endpoint type      | Limit                                   |
| ------------------ | --------------------------------------- |
| Auth endpoints     | 10 req/min per IP                       |
| REST API           | 100 req/min per user                    |
| Binary uploads     | 10 uploads/min per user                 |
| WebSocket messages | 200 msg/sec burst, 50 msg/sec sustained |

---

## 24. Performance requirements

## 24.1 MVP expected scale

- Small teams (2–10 users)
- Report-sized workspaces (dozens to low hundreds of files)
- A few simultaneous users per file

## 24.2 Client performance

- Load Yjs docs only for files open in an editor.
- Use `fileContentChanged` events for closed files (no in-memory Yjs doc needed).
- Binary downloads at max 4 parallel; uploads at max 2 parallel.

## 24.3 Server performance

- Lazy Yjs doc loading (only load into memory on subscribe).
- File tree cached in memory per workspace; invalidated on structural changes.
- Binary blobs streamed (no full buffer in memory).
- Periodic Yjs compaction triggered asynchronously.

---

## 25. Compatibility requirements

The extension should:
- use standard VS Code extension APIs
- avoid Microsoft-specific online dependencies
- package as VSIX
- support VS Code-compatible desktop forks (Cursor, VSCodium) where possible

---

## 26. Suggested implementation phases

## Phase 1: MVP foundation (Weeks 1–6)

**Backend**:
- Project setup: Node.js/TypeScript, PostgreSQL.
- Auth service: register, login, refresh, me.
- Health endpoint with version info.
- Workspace service: create, list, get.
- Transactional import service: begin/upload/commit/abort.
- File tree service: create, rename, delete, change log.
- Binary blob storage: upload/download, content-addressable.
- Yjs persistence: update storage, snapshot, doc load.
- WebSocket server: auth, workspace subscription, Yjs relay, file events.

**Extension**:
- Auth flow: login prompt, token storage, refresh mutex.
- Initialize command: scan, transactional import, write `.shynkro/`.
- Clone command: snapshot, download, write `.shynkro/`, clone-in-progress recovery.
- Auto-detect: `.shynkro/project.json` on folder open + server validation.
- SQLite state.db with schema.
- Sync engine: reconciliation via change log, file watching, write-tagging.
- Yjs editor bridge: open file → subscribeDoc, edit ↔ Yjs ops.
- Binary sync: watch, hash, upload, download.
- Status bar: connected/disconnected/syncing.
- Multi-instance lock file.
- `.gitignore` auto-update on init.

**Deliverable**: Two users can init a workspace, clone it, collaboratively edit `.typ` files, sync binary assets, reconnect after disconnect.

## Phase 2: Robustness (Weeks 7–10)

- Reconnect with exponential backoff and full reconciliation.
- Operation queue for offline resilience.
- Presence UI (sidebar showing connected users).
- Cursor/selection sharing via Yjs awareness.
- Permission change propagation and live enforcement.
- `.shynkroignore` support.
- External edit detection: small-diff import + large-diff warning.
- Mass external change detection (git checkout guard).
- Proper error notifications and status UI.
- Member management API and basic invite flow.
- Re-link workspace command.
- Token expiry and WebSocket refresh flow.

## Phase 3: Scale and Polish (Weeks 11–14)

- Yjs compaction automation and monitoring.
- Workspace export (zip download).
- Transfer ownership.
- Rate limiting enforcement.
- Workspace deletion with client notification.
- Protocol version negotiation.
- `.shynkro/environment.json` (Typst version, fonts).
- Archive/restore workspace.
- `S3StorageBackend` adapter (MinIO, AWS S3, Cloudflare R2, Backblaze B2).

## Phase 4: Advanced (Future)

- Version history and rollback.
- Comments / review.
- Workspace sharing via invite links.
- Conflict resolution tools for binary files.
- Horizontal scaling (sticky sessions, shared Yjs state via Redis).
- OAuth integration.

---

## 27. Acceptance criteria

## 27.1 Initialization

- User can open a local folder and initialize it as a collaborative workspace.
- Import is transactional: partial failure does not leave a broken workspace.
- `.shynkro/` is created only after successful commit.
- Reopening the folder reconnects automatically.

## 27.2 Collaboration

- Two users can open the same workspace.
- Two users can concurrently edit `main.typ`.
- Both see updates live.
- No user must host the session.

## 27.3 Binary sync

- User A adds or replaces `assets/logo.png`.
- User B receives the updated file locally.

## 27.4 Persistence

- After all users disconnect, reopening later restores latest workspace state.

## 27.5 Local rendering

- Typst can render from local mirrored files without server-side compilation.

## 27.6 Resilience

- A user disconnecting mid-edit does not corrupt the Yjs document.
- A client reconnecting after 5 minutes offline reconciles correctly.
- If a binary file was modified both locally and on the server while offline, the user is presented with a conflict panel to choose which version to keep.
- Deleting `.shynkro/state.db` does not cause permanent data loss; re-link restores it from server.

---

## 28. Open design questions

Remaining questions to resolve before implementation deepens:

1. **Auth provider**: Built-in username/password for MVP, or OAuth from the start? Recommendation: built-in for MVP, OAuth in Phase 3.
2. **Self-hosted vs managed**: Is the server always self-hosted? Recommendation: design for self-hosted; managed offering is a business decision.
3. **Workspace archival**: Can archived workspaces be reactivated? Recommendation: yes, archived = read-only, reactivation restores editing.

---

## 29. Final architecture summary

This system is a **server-backed collaborative workspace platform** for VS Code.

### Core rules

- **Folder = workspace**
- **Server = permanent authority**
- **No host user**
- **Text files = Yjs collaborative documents (one doc per file)**
- **Binary files = synchronized, content-addressable server-managed blobs**
- **Local folder = synchronized mirror, always reconcilable from server**
- **`.shynkro/` = workspace identity and reconnect trigger**
- **`state.db` = SQLite, authoritative local mapping and operation queue**
- **Typst rendering = local**
- **Writes = atomic (temp + rename) + write-tagged to prevent sync loops**
- **Conflicts = serialized at server with revision-based detection**
