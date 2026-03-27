import * as path from "path"

/**
 * Safely join a root directory with an untrusted relative path.
 * Returns null if the resolved path escapes the root (path traversal).
 */
export function safeJoin(root: string, untrustedRelPath: string): string | null {
  const resolved = path.resolve(root, untrustedRelPath)
  const rootResolved = path.resolve(root)
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return null
  }
  return resolved
}
