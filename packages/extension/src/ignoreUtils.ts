import * as fs from "fs"
import * as path from "path"
import { DEFAULT_IGNORE, SHYNKROIGNORE } from "./constants"
import { SHYNKRO_TMP_PREFIX } from "./text/atomicWrite"

/**
 * Build an ignore function from DEFAULT_IGNORE + optional .shynkroignore file.
 * The returned function takes a path relative to root (always "/" separators)
 * and returns true if it should be excluded from sync.
 *
 * Also ignores in-flight atomic-write sidecars whose basename starts with
 * SHYNKRO_TMP_PREFIX — these are created and renamed away by atomicWriteFileSync.
 */
export function buildIgnoreMatcher(root: string): (relPath: string) => boolean {
  const patterns = loadShynkroIgnore(root)
  return (relPath: string) => {
    const parts = relPath.split("/")
    if (parts.some((p) => DEFAULT_IGNORE.has(p) || p.startsWith(SHYNKRO_TMP_PREFIX))) return true
    for (const pat of patterns) {
      if (matchIgnorePattern(pat, relPath, parts)) return true
    }
    return false
  }
}

function loadShynkroIgnore(root: string): string[] {
  const ignorePath = path.join(root, SHYNKROIGNORE)
  if (!fs.existsSync(ignorePath)) return []
  return fs
    .readFileSync(ignorePath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
}

/**
 * Gitignore-style pattern matching.
 * - No slash (except trailing): match against any individual path segment
 * - With slash: match against full relative path (leading slash = anchored to root)
 */
function matchIgnorePattern(pattern: string, relPath: string, parts: string[]): boolean {
  const pat = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern

  if (!pat.includes("/")) {
    return parts.some((segment) => globMatch(pat, segment))
  }

  const anchored = pat.startsWith("/") ? pat.slice(1) : pat
  // Match full path OR any path that is inside this directory
  return globMatch(anchored, relPath) || relPath.startsWith(anchored + "/")
}

/** Glob matching supporting * (non-slash chars) and ** (any chars including slash) */
function globMatch(pattern: string, str: string): boolean {
  const regexStr = pattern
    .split("**")
    .map((seg) =>
      seg
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
    )
    .join(".*")
  return new RegExp(`^${regexStr}$`).test(str)
}
