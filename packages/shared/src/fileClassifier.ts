import { isText } from "istextorbinary"
import type { FileKind } from "./types/workspace.js"

/**
 * Classify a file by filename alone.
 * Returns null if the extension is unknown (caller should use classifyFileWithContent).
 */
export function classifyFile(filePath: string): FileKind | null {
  const result = isText(filePath)
  if (result === true) return "text"
  if (result === false) return "binary"
  return null
}

/**
 * Classify a file using both path and content buffer.
 * Inspects bytes for binary markers when the extension is unknown.
 */
export function classifyFileWithContent(filePath: string, content: Buffer): FileKind {
  const result = isText(filePath, content)
  if (result === false) return "binary"
  return "text"
}
