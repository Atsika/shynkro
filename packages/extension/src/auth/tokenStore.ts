import * as vscode from "vscode"

export class TokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(serverUrl: string, kind: "access" | "refresh"): string {
    return `shynkro.${kind}Token.${serverUrl}`
  }

  async getAccessToken(serverUrl: string): Promise<string | undefined> {
    return this.secrets.get(this.key(serverUrl, "access"))
  }

  async getRefreshToken(serverUrl: string): Promise<string | undefined> {
    return this.secrets.get(this.key(serverUrl, "refresh"))
  }

  async setTokens(serverUrl: string, access: string, refresh: string): Promise<void> {
    await this.secrets.store(this.key(serverUrl, "access"), access)
    await this.secrets.store(this.key(serverUrl, "refresh"), refresh)
  }

  async clearTokens(serverUrl: string): Promise<void> {
    await this.secrets.delete(this.key(serverUrl, "access"))
    await this.secrets.delete(this.key(serverUrl, "refresh"))
  }
}
