import type { Server } from "bun"
import { logger } from "./logger.js"

let shuttingDown = false

export function isShuttingDown(): boolean {
  return shuttingDown
}

interface ShutdownTargets {
  server: Server<unknown>
  intervals: ReturnType<typeof setInterval>[]
  closeAllConnections: () => void
  closeDb: () => Promise<void>
}

export function setupGracefulShutdown(targets: ShutdownTargets): void {
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info("shutdown started", { signal })

    // Stop accepting new connections
    targets.server.stop()

    // Clear background job intervals
    for (const interval of targets.intervals) {
      clearInterval(interval)
    }

    // Drain WebSocket connections
    targets.closeAllConnections()

    // Close database
    await targets.closeDb()

    logger.info("shutdown complete")
    process.exit(0)
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}
