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

| Variable               | Description                       | Default   |
| ---------------------- | --------------------------------- | --------- |
| `DATABASE_URL`         | PostgreSQL connection string      | —         |
| `JWT_SECRET`           | Secret for signing access tokens  | —         |
| `REFRESH_TOKEN_SECRET` | Secret for signing refresh tokens | —         |
| `SHYNKRO_BLOB_DIR`     | Directory for binary file storage | `./blobs` |
| `PORT`                 | HTTP port                         | `3000`    |

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
