export const EXTENSION_VERSION = "0.1.0"
export const SHYNKRO_DIR = ".shynkro"
export const PROJECT_JSON = "project.json"
export const STATE_DB = "state.db"
export const LOCK_FILE = "lock"
export const RECONNECT_BASE_MS = 1000
export const RECONNECT_MAX_MS = 5000
export const PING_INTERVAL_MS = 10000
export const PONG_TIMEOUT_MS = 5000
export const TOKEN_REFRESH_BEFORE_EXPIRY_MS = 60000
export const CHANGE_POLL_INTERVAL_MS = 30000
export const IMPORT_CONCURRENCY = 10
export const SHYNKROIGNORE = ".shynkroignore"
export const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".shynkro",
  ".DS_Store",
  ".env",
  "out",
  "dist",
  "build",
])
