const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS

const minLevel = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info
const isProduction = process.env.NODE_ENV === "production"

function write(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return

  const out = level === "error" || level === "warn" ? console.error : console.log

  if (isProduction) {
    out(JSON.stringify({ level, msg, ...extra, ts: new Date().toISOString() }))
  } else {
    const tag = level.toUpperCase().padEnd(5)
    const suffix = extra ? ` ${JSON.stringify(extra)}` : ""
    out(`${new Date().toISOString()} ${tag} ${msg}${suffix}`)
  }
}

export const logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => write("debug", msg, extra),
  info:  (msg: string, extra?: Record<string, unknown>) => write("info", msg, extra),
  warn:  (msg: string, extra?: Record<string, unknown>) => write("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write("error", msg, extra),
}
