# Shynkro — Integration Test Checklist

Run these tests in order. Each builds on the previous state.

## Setup

- [x] Start the server: `bun run dev:server`
- [x] Build the extension: `bun run --cwd packages/extension compile`
- [x] Open **two VS Code windows** (Window A and Window B), each on a different empty folder
- [x] Install the freshly built extension in both (or use the dev extension host)
- [x] Set server URL in both: **Shynkro: Set Server URL** -> `http://localhost:3000`

---

## Auth

### Test 1 — Login / Register visibility
- [x] Open the command palette — you should see **"Shynkro: Login / Register"** and NOT see "Shynkro: Logout"
- [x] Run **Shynkro: Login / Register** — a quick-pick appears with two options: **Login** and **Register**
- [x] Pick **Register**, create an account (one per window, different usernames)
- [x] Open the command palette again — you should now see **"Shynkro: Logout"** and NOT see "Login / Register"
- [x] Run **Shynkro: Logout** — command palette should flip back to showing "Login / Register"
- [x] Log back in via **Shynkro: Login / Register** -> **Login**

---

## Core sync

### Test 2 — Workspace init + clone + live text sync
- [x] **Window A:** Run **Shynkro: Init Workspace** -> creates the workspace
- [x] **Window A:** Create `findings/sqli.md` with some content
- [x] **Window A:** Copy workspace ID via **Shynkro: Copy Workspace ID**
- [x] **Window B:** Run **Shynkro: Clone Workspace** -> paste the workspace ID
- [x] **Window B:** Verify `findings/sqli.md` appeared with the same content
- [x] **Window A:** Edit `findings/sqli.md` — type a few lines
- [x] **Window B:** Verify edits appear in real-time without a conflict dialog

### Test 3 — Case-insensitive path collision (A3)
- [x] **Window A:** Create `findings/XSS.md`
- [x] **Window B:** Try creating `findings/xss.md` (different case)
- [x] **Window B:** Should see a warning about `PATH_CASE_COLLISION` and the file is NOT created

### Test 4 — File rename preserves history (A6)
- [x] **Window A:** Right-click `findings/sqli.md` -> Rename to `findings/sql-injection.md`
- [x] **Window B:** File appears at the new name with all original content (not a delete + empty create)

### Test 5 — Symlink rejection (A4)
- [ ] **Window A terminal:** `ln -s /etc/hosts findings/symlink-test`
- [ ] **Window A:** Check Shynkro output channel for `skipping symlink: findings/symlink-test`
- [ ] **Window B:** Verify the symlink does NOT appear

---

## Binary sync

### Test 6 — Small binary + mode bits (A5)
- [x] **Window A terminal:**
  ```bash
  mkdir -p scans
  dd if=/dev/urandom bs=1024 count=50 of=scans/small-scan.bin 2>/dev/null
  chmod 755 scans/small-scan.bin
  ```
- [x] **Window B:** Wait a few seconds, verify `scans/small-scan.bin` exists
- [x] **Window B terminal:** `ls -la scans/small-scan.bin` — should show mode `755`

### Test 7 — Large binary chunked upload (D1)
- [ ] **Window A terminal:**
  ```bash
  dd if=/dev/urandom bs=1M count=20 of=scans/big-scan.bin 2>/dev/null
  ```
- [ ] **Window A:** Watch for progress notification: "Shynkro: uploading big-scan.bin ..."
- [ ] **Window A:** Check output channel for `chunked upload complete`
- [ ] **Window B:** Watch for progress notification: "Shynkro: downloading big-scan.bin ..."
- [ ] **Window B terminal:** `sha256sum scans/big-scan.bin` — compare hash with Window A

---

## Robustness

### Test 8 — Paste splitting (D6)
- [x] **Window A:** Open `findings/sql-injection.md`
- [x] Generate 1 MB of text: `python3 -c "print('A' * 1048576)"` and copy it to clipboard
- [x] Paste into the editor
- [x] Check output channel for `paste-chunking ... change(s) with oversized insert(s)`
- [x] **Window B:** Verify the pasted content appears (may take a moment)

### Test 9 — Offline queue + reconnect (B2, B3)
- [ ] **Stop the server** (Ctrl+C in the server terminal)
- [ ] **Window A:** Create `findings/offline-test.md` with some content (status bar should show "disconnected")
- [ ] **Restart the server:** `bun run dev:server`
- [ ] **Window A:** Wait for reconnection (status bar goes to "connected")
- [ ] Check output channel for `draining ... pending op(s)` and `replayed create`
- [ ] **Window B:** Verify `findings/offline-test.md` appeared

### Test 10 — Permission demotion (B5)
- [ ] **Window A** (owner): Presence sidebar -> right-click Window B's user -> **Change Role** -> Viewer
- [ ] **Window B:** Verify:
  - [ ] Persistent "Viewer (read-only)" appears in the status bar
  - [ ] Editor becomes read-only (try typing — should be blocked or reverted)
- [ ] **Window A:** Change role back to **Editor**
- [ ] **Window B:** Editor becomes writable again, status bar warning disappears

### Test 11 — File deletion while editor is open (B7)
- [ ] **Window B:** Open `findings/sql-injection.md` and make an unsaved edit (type something, don't save)
- [ ] **Window A:** Delete `findings/sql-injection.md` from the explorer
- [ ] **Window B:** Verify:
  - [ ] A dialog appears asking to save a recovery copy
  - [ ] Click "Save Local Copy" — a `.recovered-<timestamp>` file should appear
  - [ ] The editor tab closes

### Test 12 — Member removal recovery (B6)
- [ ] **Window A:** Presence sidebar -> right-click Window B's user -> **Remove from Workspace**
- [ ] **Window B:** Verify:
  - [ ] Warning about being removed
  - [ ] If pending ops existed, check `.shynkro/recovery/` for a JSON dump
  - [ ] Sync stops

---

## Operations

### Test 13 — Graceful shutdown (E1)
- [ ] **Window A:** Make sure you're connected and editing
- [ ] **Terminal:** `kill -SIGTERM $(pgrep -f "bun run.*src/index.ts")`
- [ ] **Window A:** Check output channel for `received serverShutdown — flushing pending ops`
- [ ] Restart the server and verify reconnection works

### Test 14 — Health check (E2)
- [ ] **Terminal:** `curl -s http://localhost:3000/api/v1/health | python3 -m json.tool`
- [ ] Verify: `status: "ok"`, `database: "ok"`, `storage: "ok"`, `schema: "ok"`

### Test 15 — Request ID (E4)
- [ ] **Terminal:** `curl -sI http://localhost:3000/api/v1/health | grep -i request-id`
- [ ] Verify: `x-shynkro-request-id: <some UUID>` is present

---

## Results

| Test | Pass | Notes |
|------|------|-------|
| 1. Login/Register visibility | | |
| 2. Init + clone + live sync | | |
| 3. Case-insensitive collision | | |
| 4. Rename preserves history | | |
| 5. Symlink rejection | | |
| 6. Small binary + mode bits | | |
| 7. Large binary chunked upload | | |
| 8. Paste splitting | | |
| 9. Offline queue + reconnect | | |
| 10. Permission demotion | | |
| 11. File deletion while open | | |
| 12. Member removal recovery | | |
| 13. Graceful shutdown | | |
| 14. Health check | | |
| 15. Request ID | | |
