import Elysia, { status } from "elysia"
import { SignJWT, jwtVerify } from "jose"
import { getUserById } from "../services/authService.js"

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET environment variable is required")
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET)
const JWT_EXPIRY = "15m"
const JWT_ISSUER = "shynkro"

export async function signJwt(payload: { sub: string }): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(JWT_EXPIRY)
    .sign(JWT_SECRET)
}

export async function verifyJwt(token: string): Promise<{ sub: string; exp: number } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { issuer: JWT_ISSUER })
    return { sub: payload.sub as string, exp: payload.exp as number }
  } catch {
    return null
  }
}

export const withAuth = new Elysia({ name: "withAuth" }).derive(
  { as: "scoped" },
  async ({ headers }) => {
    const authHeader = headers["authorization"] ?? ""
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
    if (!token) return status(401, { message: "Missing authorization token" })

    const payload = await verifyJwt(token)
    if (!payload) return status(401, { message: "Invalid or expired token" })

    const user = await getUserById(payload.sub)
    if (!user) return status(401, { message: "User not found" })

    return { user, jwtExp: payload.exp }
  }
)
