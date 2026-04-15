import * as vscode from "vscode"
import { TOKEN_REFRESH_BEFORE_EXPIRY_MS } from "../constants"
import type { RestClient } from "../api/restClient"
import type { TokenStore } from "./tokenStore"
import { log } from "../logger"

function parseJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1]
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"))
    return typeof decoded.exp === "number" ? decoded.exp : null
  } catch {
    return null
  }
}

export class AuthService {
  private refreshPromise: Promise<string> | null = null
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly restClient: RestClient
  ) {}

  async login(serverUrl: string): Promise<boolean> {
    log.appendLine("[login] started")
    const username = await vscode.window.showInputBox({ prompt: "Username", placeHolder: "your-username", ignoreFocusOut: true })
    log.appendLine(`[login] username=<provided>`)
    if (!username) return false
    const password = await vscode.window.showInputBox({ prompt: "Password", password: true, ignoreFocusOut: true })
    log.appendLine(`[login] password=${password !== undefined ? "filled" : "undefined"}`)
    if (!password) return false

    try {
      log.appendLine("[login] calling server")
      const res = await this.restClient.login({ username, password })
      log.appendLine(`[login] success, storing tokens`)
      await this.tokenStore.setTokens(serverUrl, res.accessToken, res.refreshToken)
      this.scheduleAutoRefresh(serverUrl, res.accessToken)
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.appendLine(`[login] error: ${msg}`)
      vscode.window.showErrorMessage(`Shynkro login failed: ${msg}`)
      return false
    }
  }

  async register(serverUrl: string): Promise<boolean> {
    const username = await vscode.window.showInputBox({ prompt: "Username", placeHolder: "your-username", ignoreFocusOut: true })
    if (!username) return false
    const password = await vscode.window.showInputBox({ prompt: "Password", password: true, ignoreFocusOut: true })
    if (!password) return false

    try {
      const res = await this.restClient.register({ username, password })
      await this.tokenStore.setTokens(serverUrl, res.accessToken, res.refreshToken)
      this.scheduleAutoRefresh(serverUrl, res.accessToken)
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`Shynkro register failed: ${msg}`)
      return false
    }
  }

  async logout(serverUrl: string): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    await this.tokenStore.clearTokens(serverUrl)
  }

  async hasCredentials(serverUrl: string): Promise<boolean> {
    return !!(await this.tokenStore.getRefreshToken(serverUrl))
  }

  async getValidAccessToken(serverUrl: string): Promise<string | undefined> {
    // If a refresh is in-flight, join it
    if (this.refreshPromise) return this.refreshPromise

    const access = await this.tokenStore.getAccessToken(serverUrl)
    if (access) {
      const exp = parseJwtExp(access)
      if (exp && Date.now() / 1000 < exp - 30) {
        return access
      }
    }

    // Only attempt refresh if we actually have a refresh token
    const refreshToken = await this.tokenStore.getRefreshToken(serverUrl)
    if (!refreshToken) return undefined

    this.refreshPromise = this.doRefresh(serverUrl).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private async doRefresh(serverUrl: string): Promise<string> {
    const refreshToken = await this.tokenStore.getRefreshToken(serverUrl)
    if (!refreshToken) throw new Error("No refresh token")

    // Use a direct fetch — restClient.refresh() would call getToken() → getValidAccessToken()
    // → return this.refreshPromise, causing a deadlock where the refresh waits for itself.
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)
    let res: Response
    try {
      res = await fetch(`${serverUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
        signal: controller.signal,
      })
    } catch {
      // Network error or timeout (server unreachable) — keep tokens intact so
      // reconnect can retry once the server comes back up. Do NOT clear tokens here.
      throw new Error("Server unreachable")
    } finally {
      clearTimeout(timeoutId)
    }

    if (!res.ok) {
      // Server explicitly rejected the refresh token — session is truly invalid.
      await this.tokenStore.clearTokens(serverUrl)
      vscode.window.showErrorMessage("Shynkro: session expired — please log in again.")
      throw new Error("Session expired — please log in again")
    }

    const data = await res.json() as import("@shynkro/shared").AuthTokens
    await this.tokenStore.setTokens(serverUrl, data.accessToken, data.refreshToken)
    this.scheduleAutoRefresh(serverUrl, data.accessToken)
    return data.accessToken
  }

  scheduleAutoRefresh(serverUrl: string, accessToken: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)

    const exp = parseJwtExp(accessToken)
    if (!exp) return

    const msUntilExpiry = exp * 1000 - Date.now()
    const delay = Math.max(0, msUntilExpiry - TOKEN_REFRESH_BEFORE_EXPIRY_MS)

    this.refreshTimer = setTimeout(() => {
      this.getValidAccessToken(serverUrl).catch(() => {})
    }, delay)
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }
}
