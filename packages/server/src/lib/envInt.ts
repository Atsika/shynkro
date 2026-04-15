import { logger } from "./logger.js"

/** Parse a positive integer from an env var, falling back to `defaultValue`. */
export function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const parsed = parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(`${name} is not a positive integer, falling back to default`, { raw })
    return defaultValue
  }
  return parsed
}
