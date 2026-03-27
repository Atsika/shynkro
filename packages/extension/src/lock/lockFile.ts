import * as fs from "fs"
import * as path from "path"
import { LOCK_FILE } from "../constants"

interface LockData {
  pid: number
  startedAt: string
}

function lockPath(shynkroDir: string): string {
  return path.join(shynkroDir, LOCK_FILE)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireLock(shynkroDir: string): boolean {
  const file = lockPath(shynkroDir)
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })

  // Try atomic create (O_EXCL fails if file exists)
  try {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
    fs.writeSync(fd, payload)
    fs.closeSync(fd)
    return true
  } catch {
    // File exists — check if the existing lock is stale
  }

  try {
    const raw = fs.readFileSync(file, "utf-8")
    const data = JSON.parse(raw) as LockData

    // Already ours — refresh
    if (data.pid === process.pid) {
      fs.writeFileSync(file, payload, "utf-8")
      return true
    }

    const STALE_AFTER_MS = 5 * 60 * 1000
    const lockAge = Date.now() - new Date(data.startedAt).getTime()

    if (isProcessAlive(data.pid) && lockAge < STALE_AFTER_MS) {
      return false
    }
  } catch {
    // Lock file corrupt — take over
  }

  // Stale or corrupt — overwrite
  fs.writeFileSync(file, payload, "utf-8")
  return true
}

export function releaseLock(shynkroDir: string): void {
  try {
    fs.unlinkSync(lockPath(shynkroDir))
  } catch {}
}
