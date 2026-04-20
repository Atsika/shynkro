/** Wire-frame utilities for Yjs updates. Pure functions, no instance state. */

import { randomUUID } from "node:crypto"
import { WS_BINARY_YJS_UPDATE } from "@shynkro/shared"

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Fresh UUIDv4 identifying a single Yjs update row end-to-end. */
export function generateClientUpdateId(): string {
  return randomUUID()
}

/**
 * Build a Shynkro binary WS frame: one-byte type tag, 16-byte UUID, payload.
 * Used for STATE and AWARENESS frames; outbound YJS_UPDATE frames must use
 * {@link buildYjsUpdateFrame} instead so the sender-private clientUpdateId is
 * embedded for server-side ack correlation.
 */
export function buildBinaryFrame(frameType: number, docId: string, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 16 + data.length)
  frame[0] = frameType
  frame.set(uuidToBytes(docId), 1)
  frame.set(data, 17)
  return frame
}

/**
 * Protocol-v2 outbound YJS_UPDATE frame:
 *   [type(1)][docId(16)][clientUpdateId(16)][update(N)]
 * The server parses the ID, persists the update, then sends a
 * `yjsUpdateAck` JSON message carrying the same ID back to the sender.
 * Peers receive the frame with the clientUpdateId stripped.
 */
export function buildYjsUpdateFrame(
  docId: string,
  clientUpdateId: string,
  update: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(1 + 16 + 16 + update.length)
  frame[0] = WS_BINARY_YJS_UPDATE
  frame.set(uuidToBytes(docId), 1)
  frame.set(uuidToBytes(clientUpdateId), 17)
  frame.set(update, 33)
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
