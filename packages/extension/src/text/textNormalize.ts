/**
 * Text normalization helpers for cross-OS text file handling.
 *
 * Two collaborators editing the same file from Linux + Windows previously hit
 * phantom whole-file conflicts whenever the line endings or BOM differed.
 * This module canonicalizes the form of text held inside the Yjs document
 * (always LF, never with BOM) and preserves the original disk format per file
 * via metadata persisted in stateDb.
 */

import * as os from "os"

/** End-of-line style as it appears on disk for a given file. */
export type EolStyle = "lf" | "crlf"

/** UTF-8 BOM characters and bytes. */
export const BOM_CHAR = "\ufeff"
export const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf])

/** Detect whether a UTF-8 string starts with a BOM. */
export function hasBom(text: string): boolean {
  return text.length > 0 && text.charCodeAt(0) === 0xfeff
}

/** Strip a leading BOM from a UTF-8 string, if present. */
export function stripBom(text: string): string {
  return hasBom(text) ? text.slice(1) : text
}

/**
 * Detect the predominant EOL style of a sample of text.
 * Used on first ingest of a file to remember its native style.
 */
export function detectEol(sample: string): EolStyle {
  // CRLF wins if any \r\n appears — we never want to silently downgrade
  // to LF a file that originally had CRLF anywhere.
  return sample.indexOf("\r\n") !== -1 ? "crlf" : "lf"
}

/** Convert any text to canonical LF form (collapses CRLF and lone CR). */
export function toLf(text: string): string {
  // Replace CRLF first, then any remaining lone CR (rare, classic Mac).
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Expand canonical LF text to the requested EOL style. */
export function fromLf(lfText: string, eol: EolStyle): string {
  if (eol === "lf") return lfText
  return lfText.replace(/\n/g, "\r\n")
}

/**
 * Read a text file from disk and return its canonical (LF, no BOM) form
 * along with the metadata needed to reconstruct the original on write-back.
 */
export interface DecodedTextFile {
  /** Canonical content with CRLF and lone CR collapsed to LF and BOM stripped. */
  content: string
  /** Original EOL style as observed on disk. */
  eol: EolStyle
  /** Whether the original file started with a UTF-8 BOM. */
  bom: boolean
}

export function decodeTextFile(raw: string): DecodedTextFile {
  const bom = hasBom(raw)
  const stripped = bom ? raw.slice(1) : raw
  const eol = detectEol(stripped)
  return { content: toLf(stripped), eol, bom }
}

/**
 * Encode canonical (LF, no BOM) text into the byte form expected on disk for
 * a given file's stored eol/bom metadata. If `eol` is not known yet, fall back
 * to the OS default — this matches what a freshly-created local file would
 * have looked like before shynkro touched it.
 */
export function encodeTextForDisk(
  lfText: string,
  eol: EolStyle | null | undefined,
  bom: boolean
): string {
  const effectiveEol: EolStyle = eol ?? defaultEol()
  const withEol = fromLf(lfText, effectiveEol)
  return bom ? BOM_CHAR + withEol : withEol
}

/** OS default EOL style — used when no per-file metadata exists yet. */
export function defaultEol(): EolStyle {
  return os.platform() === "win32" ? "crlf" : "lf"
}
