/**
 * Per-request HTTP context (E4) and active-request counter (E1).
 *
 * The counter is incremented at the start of every Elysia HTTP request and
 * decremented in onAfterResponse — the graceful-shutdown drain reads it to
 * decide when it's safe to force-close.
 *
 * The X-Shynkro-Request-Id header gives every request a UUID that surfaces
 * in the response and (via `withRequestId` below) into every log line emitted
 * during that request — cheap correlation when a pentester reports lost data
 * later and we need to trace which exact request handled their op.
 */

import { randomUUID } from "node:crypto"
import { logger } from "./logger.js"

let activeRequests = 0

export function getActiveRequestCount(): number {
  return activeRequests
}

export function incrementActiveRequests(): void {
  activeRequests++
}

export function decrementActiveRequests(): void {
  if (activeRequests > 0) activeRequests--
}

export const REQUEST_ID_HEADER = "x-shynkro-request-id"

/**
 * Resolve the request ID for an incoming request — honours an existing
 * X-Shynkro-Request-Id header (so a load balancer or test harness can
 * propagate one in) and generates a fresh UUID otherwise.
 */
export function resolveRequestId(headers: Headers | Record<string, string | undefined>): string {
  const incoming =
    headers instanceof Headers ? headers.get(REQUEST_ID_HEADER) : headers[REQUEST_ID_HEADER]
  if (incoming && /^[\w.\-:]{1,128}$/.test(incoming)) return incoming
  return randomUUID()
}

/**
 * Wrap a logger with a request ID so every line emitted during the request
 * carries the same `requestId` field. The shape mirrors the global `logger`
 * so call sites stay identical — `req.logger.info("...")` instead of
 * `logger.info("...")`.
 */
export function withRequestId(requestId: string) {
  const wrap = (level: "debug" | "info" | "warn" | "error") =>
    (msg: string, extra?: Record<string, unknown>) =>
      logger[level](msg, { requestId, ...(extra ?? {}) })
  return {
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
  }
}
