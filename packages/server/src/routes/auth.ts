import Elysia, { t, status } from "elysia"
import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { users } from "../db/schema.js"
import {
  hashPassword,
  verifyPassword,
  createRefreshToken,
  rotateRefreshToken,
} from "../services/authService.js"
import { uuid } from "../utils.js"
import { signJwt, withAuth } from "../middleware/auth.js"

export const authRoutes = new Elysia({ prefix: "/api/v1/auth" })
  .post(
    "/register",
    async ({ body }) => {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, body.username))
        .limit(1)

      if (existing.length > 0) return status(409, { message: "Username already in use" })

      const id = uuid()
      const passwordHash = await hashPassword(body.password)

      await db.insert(users).values({
        id,
        username: body.username,
        passwordHash,
      })

      const accessToken = await signJwt({ sub: id })
      const refreshToken = await createRefreshToken(id)

      return {
        accessToken,
        refreshToken,
        user: { id, username: body.username },
      }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1 }),
        password: t.String({ minLength: 1 }),
      }),
    }
  )
  .post(
    "/login",
    async ({ body }) => {
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.username, body.username))
        .limit(1)

      if (!user) return status(401, { message: "Invalid credentials" })

      const valid = await verifyPassword(user.passwordHash, body.password)
      if (!valid) return status(401, { message: "Invalid credentials" })

      const accessToken = await signJwt({ sub: user.id })
      const refreshToken = await createRefreshToken(user.id)

      return {
        accessToken,
        refreshToken,
        user: { id: user.id, username: user.username },
      }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1 }),
        password: t.String({ minLength: 1 }),
      }),
    }
  )
  .post(
    "/refresh",
    async ({ body }) => {
      const result = await rotateRefreshToken(body.refreshToken)
      if (!result) return status(401, { message: "Invalid or expired refresh token" })

      const accessToken = await signJwt({ sub: result.userId })
      return { accessToken, refreshToken: result.newToken }
    },
    {
      body: t.Object({ refreshToken: t.String() }),
    }
  )
  .use(withAuth)
  .get("/me", ({ user }) => ({
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
  }))
