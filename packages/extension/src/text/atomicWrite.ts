/**
 * Atomic file writes via the temp-file + rename pattern.
 *
 * Previously, all three write paths (binarySync.download, changeReconciler.applyCreated
 * text writes, yjsBridge.scheduleBackgroundWrite) wrote directly to the target via
 * fs.writeFileSync. A crash, disk-full, or process kill mid-write left the file
 * partially written — and for large binaries, that means silent corruption with no
 * recovery path.
 *
 * The atomic pattern here:
 *   1. Write the full content to `<dir>/.shynkro-tmp-<rand>-<basename>` in the same
 *      directory (guaranteed same filesystem → fs.renameSync is a single rename(2)
 *      syscall, atomic on POSIX and same-volume Windows).
 *   2. fs.renameSync onto the target, atomically replacing any existing content.
 *   3. On any failure, unlink the temp file so we never leak sidecars.
 *
 * The temp filename prefix is recognized by fileWatcher.shouldIgnore via the
 * `isShynkroTempPath` helper below — the watcher ignores both the temp file's
 * create and delete events, and the target's change event is still suppressed
 * by the existing write-tag mechanism.
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

export const SHYNKRO_TMP_PREFIX = ".shynkro-tmp-"

/** True if a path segment belongs to an in-flight atomic write (temp sidecar). */
export function isShynkroTempPath(relPath: string): boolean {
  const parts = relPath.split("/")
  return parts.some((seg) => seg.startsWith(SHYNKRO_TMP_PREFIX))
}

/** Build a temp path in the same directory as the target. */
function tempPathFor(target: string): string {
  const dir = path.dirname(target)
  const base = path.basename(target)
  const rand = crypto.randomBytes(6).toString("hex")
  return path.join(dir, `${SHYNKRO_TMP_PREFIX}${rand}-${base}`)
}

/**
 * Atomically write `data` (string or buffer) to `target`. The target's parent
 * directory is created if missing. On any error mid-write, the temp sidecar
 * is removed so the filesystem never carries partial state.
 *
 * @param target  Absolute target path.
 * @param data    Bytes or UTF-8 text to write.
 * @param opts    Optional fs.writeFileSync options (encoding, mode).
 */
export function atomicWriteFileSync(
  target: string,
  data: string | Uint8Array,
  opts?: { encoding?: BufferEncoding; mode?: number }
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = tempPathFor(target)
  try {
    if (typeof data === "string") {
      fs.writeFileSync(tmp, data, { encoding: opts?.encoding ?? "utf-8", mode: opts?.mode })
    } else {
      fs.writeFileSync(tmp, data, { mode: opts?.mode })
    }
    fs.renameSync(tmp, target)
  } catch (err) {
    // Best-effort cleanup. If the rename failed the temp file still exists;
    // if the write failed it may also exist (node creates the file before filling it).
    try { fs.unlinkSync(tmp) } catch { /* already gone */ }
    throw err
  }
}
