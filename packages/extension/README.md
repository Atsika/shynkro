# Shynkro

**Real-time collaborative workspace synchronization**

Shynkro lets multiple developers edit the same folder in real time from their own VS Code. Every participant keeps a full local copy — your compilers, linters, and tools keep working as normal. The server is always the authority; no user hosts a session.

![shynkro logo](https://raw.githubusercontent.com/atsika/shynkro/main/packages/extension/media/logo.png)

---

## Features

- **Real-time text editing** — Concurrent edits merge automatically via [Yjs](https://github.com/yjs/yjs) CRDTs, character by character
- **Binary file sync** — Images, PDFs, and assets are synced whole with hash-based deduplication
- **File operations** — Create, rename, and delete propagated to all members instantly
- **Cursor presence** — See who's connected, where they are, and follow their cursor
- **Conflict resolution** — Inline diff view with one-click accept when reconnect divergences are detected
- **Offline support** — Changes made while disconnected are queued and replayed on reconnect
- **External editor support** — Edits made in vim, nano, or any other editor sync automatically
- **Role-based permissions** — Owner, Editor, and Viewer roles with live enforcement

---

## Getting Started

### 1. Set Server URL

Run **Shynkro: Set Server URL** from the command palette (`Ctrl+Shift+P`) to point the extension to your Shynkro server.

### 2. Register / Login

Run **Shynkro: Register** to create an account, or **Shynkro: Login** if you already have one.

### 3. Initialize a workspace

1. Open a local folder in VS Code
2. Run **Shynkro: Init Workspace**
3. Your folder is now a collaborative workspace

### 4. Invite collaborators

- Run **Shynkro: Invite Member** and enter a username
- Or run **Shynkro: Copy Workspace ID** and share it directly

### 5. Join an existing workspace

- Run **Shynkro: Clone Workspace** and enter the workspace ID to download all files
- Or run **Shynkro: Join Workspace** to join as a viewer without downloading

---

## Commands

| Command | Description |
|---------|-------------|
| `Shynkro: Init Workspace` | Turn current folder into a synced workspace |
| `Shynkro: Clone Workspace` | Download and join a workspace by ID |
| `Shynkro: Join Workspace` | Join a workspace as viewer |
| `Shynkro: Invite Member` | Invite a user by username |
| `Shynkro: Copy Workspace ID` | Copy the workspace ID to clipboard |
| `Shynkro: Re-link Workspace` | Re-link a folder to an existing workspace |
| `Shynkro: Delete Workspace` | Delete the workspace from the server |
| `Shynkro: Set Server URL` | Configure the server endpoint |
| `Shynkro: Login` | Log in to the server |
| `Shynkro: Register` | Create a new account |
| `Shynkro: Logout` | Log out |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+Y` (`Cmd+Shift+Y` on Mac) | Accept my changes (during conflict) |
| `Ctrl+Shift+N` (`Cmd+Shift+N` on Mac) | Accept server's changes (during conflict) |

---

## Sidebar

Shynkro adds a sidebar panel to the activity bar with:

- **Connected Users** — See who's online, change roles, follow cursors, hide/show cursor labels
- **Workspace** — Quick actions (init, clone, invite, copy ID)
- **Conflicts** — List of files with unresolved conflicts

---

## Roles

| Role | Can edit | Can invite | Can manage members |
|------|----------|------------|--------------------|
| Owner | Yes | Yes | Yes |
| Editor | Yes | No | No |
| Viewer | No | No | No |

---

## Requirements

- VS Code 1.89 or later
- A running [Shynkro server](https://github.com/atsika/shynkro)

---

## License

MIT © [atsika](https://github.com/atsika)
