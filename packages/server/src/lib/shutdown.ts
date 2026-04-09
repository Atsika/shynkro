import type { Server } from "bun"
import { logger } from "./logger.js"

let shuttingDown = false

export function isShuttingDown(): boolean {
  return shuttingDown
}

interface ShutdownTargets {
  server: Server<unknown>
  intervals: ReturnType<typeof setInterval>[]
  /** Notify all WS clients of imminent shutdown so they can cleanly stop sending. */
  notifyAllConnectionsShuttingDown: () => void
  /** Force-close any WS that didn't disconnect during the grace period. */
  closeAllConnections: () => void
  /** Count of currently-open WS connections — used to short-circuit the drain wait. */
  activeConnectionCount: () => number
  /** Count of currently-active HTTP requests — short-circuits the HTTP drain wait. */
  activeRequestCount: () => number
  closeDb: () => Promise<void>
}

/**
 * Configurable drain windows. Defaults are deliberately tight for the
 * pentester team threat model — long enough that an in-flight upload finishes,
 * short enough that a hung request doesn't keep the server up forever.
 *
 *   SHYNKRO_HTTP_DRAIN_MS  default 30 000 — wait for in-flight HTTP requests
 *   SHYNKRO_WS_DRAIN_MS    default 10 000 — wait for clients to disconnect cleanly
 */
const HTTP_DRAIN_MS = (() => {
  const raw = process.env.SHYNKRO_HTTP_DRAIN_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30_000
})()
const WS_DRAIN_MS = (() => {
  const raw = process.env.SHYNKRO_WS_DRAIN_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000
})()

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait until either `predicate()` returns true or `timeoutMs` elapses.
 * Polls every 200 ms — chosen so a fast drain finishes promptly without
 * burning CPU during the wait.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      logger.warn("drain timed out", { label, timeoutMs })
      return false
    }
    await sleep(200)
  }
  return true
}

export function setupGracefulShutdown(targets: ShutdownTargets): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info("shutdown started", { signal })

    // 1. Stop accepting NEW HTTP connections. The Bun server is supposed to
    //    finish in-flight requests before fully closing — server.stop(false)
    //    is the polite stop. We immediately fall into the drain wait below.
    try {
      targets.server.stop()
    } catch (err) {
      logger.error("server.stop() failed", { err: String(err) })
    }

    // 2. Clear background job intervals so they don't fire while we drain.
    for (const interval of targets.intervals) {
      clearInterval(interval)
    }

    // 3. Notify every WS client that the server is shutting down so they can
    //    flush any pending state, dump unsent ops to recovery files, and
    //    cleanly disconnect. Clients that don't react in time will be
    //    force-closed at step 5.
    try {
      targets.notifyAllConnectionsShuttingDown()
    } catch (err) {
      logger.error("notifyAllConnectionsShuttingDown failed", { err: String(err) })
    }

    // 4. Drain in-flight HTTP requests in parallel with the WS grace period.
    //    Both windows run concurrently — total worst-case shutdown time is
    //    `max(HTTP_DRAIN_MS, WS_DRAIN_MS)`, not the sum.
    const drained = await Promise.all([
      waitUntil(() => targets.activeRequestCount() === 0, HTTP_DRAIN_MS, "http"),
      waitUntil(() => targets.activeConnectionCount() === 0, WS_DRAIN_MS, "ws"),
    ])
    logger.info("drain complete", { httpDrained: drained[0], wsDrained: drained[1] })

    // 5. Force-close anything still hanging on. Logged so a stuck client is
    //    visible in operator dashboards.
    const remainingHttp = targets.activeRequestCount()
    const remainingWs = targets.activeConnectionCount()
    if (remainingHttp > 0 || remainingWs > 0) {
      logger.warn("force-closing remaining connections", { remainingHttp, remainingWs })
    }
    try {
      targets.closeAllConnections()
    } catch (err) {
      logger.error("closeAllConnections failed", { err: String(err) })
    }

    // 6. Close the database last so any in-flight handler that was draining
    //    above doesn't hit a closed pool while it commits.
    await targets.closeDb()

    logger.info("shutdown complete")
    process.exit(0)
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}
