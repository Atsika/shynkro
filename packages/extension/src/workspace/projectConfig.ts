import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { SHYNKRO_DIR, PROJECT_JSON } from "../constants"
import type { ProjectConfig } from "../types"

export function readProjectConfig(workspaceRoot: string): ProjectConfig | null {
  const configPath = path.join(workspaceRoot, SHYNKRO_DIR, PROJECT_JSON)
  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    return JSON.parse(raw) as ProjectConfig
  } catch {
    return null
  }
}

export function writeProjectConfig(workspaceRoot: string, config: ProjectConfig): void {
  const dir = path.join(workspaceRoot, SHYNKRO_DIR)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, PROJECT_JSON), JSON.stringify(config, null, 2), "utf-8")
}

export function findProjectConfig(): { root: string; config: ProjectConfig } | null {
  const folders = vscode.workspace.workspaceFolders
  if (!folders) return null
  for (const folder of folders) {
    const config = readProjectConfig(folder.uri.fsPath)
    if (config) return { root: folder.uri.fsPath, config }
  }
  return null
}
