/** Wire-frame utilities for Yjs updates. Pure functions, no instance state. */

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Build a Shynkro binary WS frame: one-byte type tag, 16-byte UUID, payload.
 * Server decodes the same layout — see shared/src/types/ws.ts constants.
 */
export function buildBinaryFrame(frameType: number, docId: string, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 16 + data.length)
  frame[0] = frameType
  frame.set(uuidToBytes(docId), 1)
  frame.set(data, 17)
  return frame
}

/**
 * Convert a VS Code editor offset (which counts \r in CRLF documents as a
 * character) into the LF-canonical offset used inside the Y.Doc.
 */
export function editorOffsetToLfOffset(editorText: string, editorOffset: number): number {
  let crCount = 0
  const limit = Math.min(editorOffset, editorText.length)
  for (let i = 0; i < limit; i++) {
    if (editorText.charCodeAt(i) === 13) crCount++
  }
  return editorOffset - crCount
}

/** Count carriage returns in [from, from+length) of the editor text. */
export function countCrInRange(editorText: string, from: number, length: number): number {
  const end = Math.min(from + length, editorText.length)
  let cr = 0
  for (let i = from; i < end; i++) {
    if (editorText.charCodeAt(i) === 13) cr++
  }
  return cr
}
