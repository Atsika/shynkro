import { randomBytes } from "node:crypto"

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("hex")
}

export function uuid(): string {
  return crypto.randomUUID()
}

export function now(): Date {
  return new Date()
}

export function addMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000)
}

export function addDays(days: number): Date {
  return new Date(Date.now() + days * 86400 * 1000)
}

export function isValidFilePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\0")) return false
  return !p.split("/").some((seg) => seg === ".." || seg === ".")
}
