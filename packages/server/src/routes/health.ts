import Elysia from "elysia"

export const healthRoutes = new Elysia().get("/api/v1/health", () => ({
  status: "ok",
  apiVersion: 1,
  minExtensionVersion: "0.1.0",
}))
