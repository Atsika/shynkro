import { logger } from "./logger.js"

/**
 * Parse a non-negative integer from an env var, falling back to `defaultValue`.
 * 0 is valid — callers use it as a hard-block sentinel for size caps.
 */
export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(`${name} is not a non-negative integer, falling back to default`, { raw })
    return defaultValue
  }
  return parsed
}
