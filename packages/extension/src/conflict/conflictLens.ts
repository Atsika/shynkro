import * as vscode from "vscode"
import type { ConflictHunkMeta } from "./diffUtils"

interface ConflictEntry {
  docId: string
  hunks: ConflictHunkMeta[]
}

/**
 * CodeLens provider that shows "Accept Mine" / "Accept Server's" buttons
 * above the first line of each unresolved conflict hunk.
 */
export class ConflictLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event

  private readonly activeConflicts = new Map<string, ConflictEntry>()

  setHunks(docUri: string, docId: string, hunks: ConflictHunkMeta[]): void {
    this.activeConflicts.set(docUri, { docId, hunks })
    this._onDidChangeCodeLenses.fire()
  }

  removeDoc(docUri: string): void {
    this.activeConflicts.delete(docUri)
    this._onDidChangeCodeLenses.fire()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entry = this.activeConflicts.get(document.uri.toString())
    if (!entry) return []

    const lenses: vscode.CodeLens[] = []
    for (const hunk of entry.hunks) {
      const range = new vscode.Range(hunk.localRange.start, 0, hunk.localRange.start, 0)

      lenses.push(
        new vscode.CodeLens(range, {
          title: "Accept local",
          command: "shynkro.acceptLocalHunk",
          arguments: [entry.docId, hunk.hunkIndex],
        }),
        new vscode.CodeLens(range, {
          title: "Accept server",
          command: "shynkro.acceptServerHunk",
          arguments: [entry.docId, hunk.hunkIndex],
        })
      )
    }
    return lenses
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose()
  }
}
