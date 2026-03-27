import * as fs from "fs"
import * as path from "path"
import { log } from "../logger"

/**
 * Adds `.shynkro/` to `.gitignore` if the workspace is a git repo and the
 * entry is not already present. Safe to call multiple times.
 */
export function ensureShynkroInGitignore(workspaceRoot: string): void {
  const gitDir = path.join(workspaceRoot, ".git")
  if (!fs.existsSync(gitDir)) return

  const gitignorePath = path.join(workspaceRoot, ".gitignore")
  let existing = ""
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf-8")
  }

  const lines = existing.split("\n").map((l) => l.trim())
  if (lines.includes(".shynkro/") || lines.includes(".shynkro")) return

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  fs.appendFileSync(gitignorePath, `${prefix}.shynkro/\n`)
  log.appendLine("[git] appended .shynkro/ to .gitignore")
}
