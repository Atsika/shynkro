import * as argon2 from "argon2"
import { eq, and, gt } from "drizzle-orm"
import { db } from "../db/index.js"
import { refreshTokens, users } from "../db/schema.js"
import { randomId, now } from "../utils.js"

const REFRESH_TOKEN_TTL_DAYS = 30

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id })
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password)
}

export async function createRefreshToken(userId: string): Promise<string> {
  const selector = randomId(16) // 16 random bytes hex — stored plaintext for lookup
  const verifier = randomId(32) // 32 random bytes hex — stored hashed
  const tokenHash = await Bun.password.hash(verifier, { algorithm: "bcrypt" })
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400 * 1000)

  await db.insert(refreshTokens).values({
    id: randomId(),
    userId,
    selector,
    tokenHash,
    expiresAt,
  })

  return `${selector}.${verifier}`
}

export async function rotateRefreshToken(
  token: string
): Promise<{ userId: string; newToken: string } | null> {
  const dotIdx = token.indexOf(".")
  if (dotIdx === -1) return null
  const selector = token.slice(0, dotIdx)
  const verifier = token.slice(dotIdx + 1)
  if (!selector || !verifier) return null

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.selector, selector), gt(refreshTokens.expiresAt, now())))
    .limit(1)

  if (!row) return null

  const valid = await Bun.password.verify(verifier, row.tokenHash)
  if (!valid) return null

  // Single-use: delete this token
  await db.delete(refreshTokens).where(eq(refreshTokens.id, row.id))
  // Issue a new one
  const newToken = await createRefreshToken(row.userId)
  return { userId: row.userId, newToken }
}

export async function getUserById(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  return user ?? null
}
