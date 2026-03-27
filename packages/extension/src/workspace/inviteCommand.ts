import * as vscode from "vscode"
import type { RestClient } from "../api/restClient"
import type { WorkspaceId } from "@shynkro/shared"

export async function executeInvite(
  workspaceId: WorkspaceId,
  restClient: RestClient
): Promise<void> {
  const username = await vscode.window.showInputBox({
    title: "Invite to Workspace",
    prompt: "Enter the username of the user to invite",
    placeHolder: "their-username",
  })
  if (!username) return

  try {
    await restClient.inviteMember(workspaceId, { username: username.trim(), role: "editor" })
    vscode.window.showInformationMessage(`Shynkro: invited ${username} as editor`)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`Shynkro: invite failed — ${msg}`)
  }
}
