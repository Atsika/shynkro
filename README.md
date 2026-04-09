# Shynkro

Persistent, server-authoritative collaborative workspace for VS Code.

Shynkro lets multiple users edit the same folder in real time. Every participant keeps a full local copy — local tools (compilers, renderers, linters) keep working as normal. The server is always the authority; no user hosts a session.

---

## How it works

- **Text files** are synchronized in real time via [Yjs](https://github.com/yjs/yjs) CRDTs — concurrent edits from multiple users merge automatically, character by character.
- **Binary files** (images, PDFs, assets) are synced whole with hash-based deduplication.
- **Folder structure** (create, rename, delete) is propagated to all members instantly.
- **Presence** shows which users are connected, their roles, and their cursor positions.
- **Conflict resolution** uses inline git-style markers when a reconnect divergence is detected.

---

## Architecture

```
┌─────────────────────┐        REST + WebSocket        ┌──────────────────────┐
│   VS Code Extension │ ◄───────────────────────────── │  Bun / Elysia Server │
│   (local mirror)    │                                │  PostgreSQL + blobs  │
└─────────────────────┘                                └──────────────────────┘
```

| Package              | Role                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `packages/server`    | Elysia HTTP + WebSocket server, Drizzle ORM, Yjs persistence     |
| `packages/extension` | VS Code extension — file sync, Yjs bridge, presence, conflict UI |
| `packages/shared`    | TypeScript types shared between server and extension             |

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [Docker](https://www.docker.com) (for PostgreSQL)
- VS Code ≥ 1.89

---

## Server setup

```bash
# 1. Install dependencies
bun install

# 2. Start PostgreSQL
docker compose up -d

# 3. Configure environment
cp packages/server/.env.example packages/server/.env
# Edit .env — set JWT_SECRET, REFRESH_TOKEN_SECRET, etc.

# 4. Run migrations
bun run --cwd packages/server db:migrate

# 5. Start server
bun run dev:server
```

The server listens on `http://localhost:3000` by default.

### Environment variables

| Variable                          | Description                                            | Default          |
| --------------------------------- | ------------------------------------------------------ | ---------------- |
| `DATABASE_URL`                    | PostgreSQL connection string                           | —                |
| `JWT_SECRET`                      | Secret for signing access tokens                       | —                |
| `REFRESH_TOKEN_SECRET`            | Secret for signing refresh tokens                      | —                |
| `SHYNKRO_BLOB_DIR`                | Directory for binary file storage                      | `./blobs`        |
| `PORT`                            | HTTP port                                              | `3000`           |
| `SHYNKRO_DB_POOL_MAX`             | Max concurrent Postgres connections                    | `20`             |
| `SHYNKRO_DB_IDLE_TIMEOUT`         | Seconds before idle connections are recycled           | `30`             |
| `SHYNKRO_HTTP_DRAIN_MS`           | Graceful-shutdown wait for in-flight HTTP requests     | `30000`          |
| `SHYNKRO_WS_DRAIN_MS`             | Graceful-shutdown wait for WS clients to disconnect    | `10000`          |
| `SHYNKRO_MAX_BLOB_SIZE`           | Max bytes per binary blob                              | `53687091200`    |
| `SHYNKRO_MAX_IMPORT_FILE_SIZE`    | Max bytes per file in an import session                | `104857600`      |
| `SHYNKRO_MAX_IMPORT_SESSION_SIZE` | Cumulative size cap on a single import session         | `5368709120`     |
| `SHYNKRO_WS_MAX_FRAME`            | Max WebSocket frame size (safety net against OOM)      | `52428800`       |

---

## Backup & restore

Shynkro has two pieces of persistent state and **both** need to be backed up together for a consistent restore:

1. **PostgreSQL** — all metadata: users, workspaces, file entries, collaborative Yjs history.
2. **Blob storage** — the raw bytes of every binary file (screenshots, PDFs, zipped scans, etc.), under `SHYNKRO_BLOB_DIR` (defaults to `./data/blobs` in the provided `docker-compose.yml`).

A PostgreSQL backup without the matching blob directory will restore to a state where every binary file is a dangling reference. Always snapshot both at the same time.

### Manual backup

From the host running `docker compose`:

```bash
# 1. Create a dated backup directory
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=./backups/$STAMP
mkdir -p "$BACKUP_DIR"

# 2. Dump Postgres (plain SQL, gzip-compressed)
docker compose exec -T postgres pg_dump -U shynkro -Fc shynkro \
  > "$BACKUP_DIR/shynkro.dump"

# 3. Snapshot the blob directory
tar -C ./data -czf "$BACKUP_DIR/blobs.tar.gz" blobs
```

### Scheduled backup (cron)

Drop this into root's crontab on the host for a nightly 02:30 backup with a 14-day retention:

```cron
30 2 * * * cd /srv/shynkro && bash -c '\
  STAMP=$(date -u +%Y%m%dT%H%M%SZ); \
  BACKUP_DIR=./backups/$STAMP; \
  mkdir -p "$BACKUP_DIR" && \
  docker compose exec -T postgres pg_dump -U shynkro -Fc shynkro > "$BACKUP_DIR/shynkro.dump" && \
  tar -C ./data -czf "$BACKUP_DIR/blobs.tar.gz" blobs && \
  find ./backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +'
```

### Restore

Stop the server first so no clients are editing while you swap state. Stop Postgres before the Postgres restore, then bring everything back up.

```bash
# 0. Stop the server (keep Postgres running for pg_restore)
docker compose stop server

# 1. Restore blobs (safe to do while Postgres runs)
rm -rf ./data/blobs
tar -C ./data -xzf ./backups/20260408T023000Z/blobs.tar.gz

# 2. Wipe and recreate the database
docker compose exec -T postgres psql -U shynkro -c 'DROP DATABASE IF EXISTS shynkro;'
docker compose exec -T postgres psql -U shynkro -c 'CREATE DATABASE shynkro;'

# 3. Restore the dump
docker compose exec -T postgres pg_restore -U shynkro -d shynkro --no-owner \
  < ./backups/20260408T023000Z/shynkro.dump

# 4. Restart the server
docker compose start server
```

### Recovery windows

Even without a full restore, a few things are recoverable in place:

- **Accidentally deleted files** — collaborative docs are soft-deleted with a 30-day recovery window. To un-delete a file, clear the `deleted_at` column on `collaborative_docs` and the `deleted` flag on `file_entries` for that `fileId`. After 30 days the `purgeDeletedDocs` job hard-deletes the row and the associated `yjs_updates` cascade away.
- **Unsynced client edits after abrupt removal** — when a user is removed from a workspace mid-session, any offline ops that couldn't land are serialized to `.shynkro/recovery/pending-ops-<timestamp>.json` inside their workspace directory. Opening the JSON shows the original path, kind, and content of each operation.

---

## Extension setup

```bash
# Build the extension
bun run --cwd packages/extension compile

# Package as .vsix for distribution
bun run --cwd packages/extension package
```

Install the built `.vsix` in VS Code:

```
Extensions panel → ··· → Install from VSIX…
```

Or via CLI:

```bash
code --install-extension packages/extension/shynkro-0.1.0.vsix
```

---

## Usage

### Initialize a workspace

1. Open a local folder in VS Code.
2. Run **Shynkro: Init Workspace** from the command palette.
3. Register or log in when prompted.
4. Your folder is now a collaborative workspace. Share your workspace ID with collaborators.

### Join an existing workspace

1. Run **Shynkro: Clone Workspace** and enter the workspace ID.
2. Or run **Shynkro: Join Workspace** to join as a viewer without downloading files.

### Share a workspace

Run **Shynkro: Share Workspace** to copy the workspace ID or invite a member by username.

### Roles

| Role   | Can edit       | Can invite |
| ------ | -------------- | ---------- |
| Owner  | Yes            | Yes        |
| Editor | Yes            | No         |
| Viewer | No (read-only) | No         |

---

## Features

- Real-time collaborative text editing with cursor presence
- Binary file sync with hash deduplication
- File create / rename / delete propagated to all members
- Inline conflict resolution (git-style markers)
- Conflict list sidebar panel
- Workspace export as ZIP (`GET /api/v1/workspaces/:id/export`)
- External editor support — edits made in vim, nano, etc. sync automatically
- Awareness TTL — ghost cursors cleared after 30 s of inactivity
- Offline queue — changes made while disconnected are replayed on reconnect
- Role-based permissions with live enforcement

---

## API

Base URL: `http://localhost:3000/api/v1`

| Method    | Path                             | Description                |
| --------- | -------------------------------- | -------------------------- |
| `POST`    | `/auth/register`                 | Create account             |
| `POST`    | `/auth/login`                    | Log in, receive tokens     |
| `POST`    | `/auth/refresh`                  | Refresh access token       |
| `GET`     | `/workspaces`                    | List joined workspaces     |
| `POST`    | `/workspaces`                    | Create workspace           |
| `GET`     | `/workspaces/:id`                | Get workspace info         |
| `PATCH`   | `/workspaces/:id`                | Rename workspace           |
| `DELETE`  | `/workspaces/:id`                | Delete workspace           |
| `GET`     | `/workspaces/:id/export`         | Download workspace as ZIP  |
| `GET`     | `/workspaces/:id/changes?since=` | Incremental change log     |
| `GET`     | `/workspaces/:id/tree`           | File tree                  |
| `GET`     | `/workspaces/files/:id`          | Get file content           |
| `POST`    | `/workspaces/:id/files`          | Create file                |
| `PATCH`   | `/workspaces/:id/files/:id`      | Rename file                |
| `DELETE`  | `/workspaces/:id/files/:id`      | Delete file                |
| `GET /WS` | `/realtime`                      | WebSocket — Yjs + presence |

---

## License

MIT © atsika
