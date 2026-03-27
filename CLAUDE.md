# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime

Use **bun** for all package management and script execution. Never use npm, npx, or node directly.

## Commands

```bash
# Development
bun run dev:server              # Start server with hot reload
bun run --cwd packages/extension build  # Build VS Code extension (outputs to out/)

# Build
bun run build                   # Build shared + server

# Database
bun run --cwd packages/server db:generate   # Generate Drizzle migrations
bun run --cwd packages/server db:migrate    # Apply migrations
bun run --cwd packages/server db:studio     # Open Drizzle Studio

# Type checking
bun run --cwd packages/server tsc --noEmit
bun run --cwd packages/extension tsc --noEmit

# Infrastructure
docker compose up -d            # Start PostgreSQL (port 5432)
```

## Architecture

Bun workspace monorepo with three packages:

- **`packages/shared`** — TypeScript types only (REST API contracts, WebSocket protocol, core data models). Built first as a dependency.
- **`packages/server`** — Elysia HTTP + WebSocket server backed by PostgreSQL (Drizzle ORM). Server-authoritative: holds the permanent state of all workspaces.
- **`packages/extension`** — VS Code extension compiled to CommonJS (`out/`). Bridges local filesystem editing with the server via REST + WebSocket.

### Data Flow

1. Extension sends REST requests for workspace operations (init/clone/join/invite)
2. On connect, extension opens a WebSocket (`wsManager`) and subscribes to workspace channels
3. Text edits flow as binary WebSocket frames: Yjs updates (0x01), state vectors (0x02), awareness (0x03)
4. Binary/blob files are synced whole via REST with hash-based deduplication
5. Local file changes are detected by `fileWatcher`, queued via `opQueue`, reconciled by `changeReconciler`
6. Conflicts are handled by `conflictManager`; local state is persisted in SQLite (`stateDb`)

### Server Route Layout

```
/api/v1/health
/api/v1/auth/*          — register, login, refresh
/api/v1/workspaces/*    — CRUD, members, invites
/api/v1/files/*         — file tree
/api/v1/blobs/*         — binary storage
/api/v1/import/*        — bulk import sessions
/api/v1/realtime        — WebSocket upgrade
```

### Key Files

| File | Purpose |
|------|---------|
| `packages/server/src/db/schema.ts` | Full DB schema (Users, Workspaces, FileEntries, WorkspaceMembers, RefreshTokens) |
| `packages/server/src/services/yjsService.ts` | Server-side Yjs document management |
| `packages/server/src/middleware/auth.ts` | JWT verification |
| `packages/server/src/lib/authz.ts` | Authorization checks |
| `packages/extension/src/extension.ts` | All VS Code command registrations |
| `packages/extension/src/ws/wsManager.ts` | WebSocket lifecycle |
| `packages/extension/src/yjs/yjsBridge.ts` | Yjs↔VS Code document bridge |
| `packages/extension/src/workspace/projectConfig.ts` | `.shynkro/project.json` read/write |
| `packages/shared/src/types/ws.ts` | WebSocket protocol (PROTOCOL_VERSION=1) |

## Environment

Copy `.env.example` to `.env` in `packages/server/`. Required vars:

```
DATABASE_URL=postgres://shynkro:shynkro@localhost:5432/shynkro
JWT_SECRET=<long random secret>
REFRESH_TOKEN_SECRET=<another long random secret>
SHYNKRO_BLOB_DIR=./blobs
PORT=3000
```
