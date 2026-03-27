import { extname } from "path"
import type { FileKind } from "@shynkro/shared"

// Must stay in sync with packages/server/src/fileClassifier.ts
export const TEXT_EXTENSIONS = new Set([
  ".typ", ".md", ".txt", ".tex",
  ".json", ".yaml", ".yml", ".toml",
  ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".html", ".css", ".scss", ".sass", ".less",
  ".sh", ".bash", ".zsh", ".fish",
  ".xml", ".svg", ".gitignore", ".gitattributes",
  ".dockerfile", ".conf", ".ini", ".cfg",
])

export function classifyFile(filePath: string): FileKind {
  const ext = extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return "text"
  if (ext === "") return "text"  // no extension → Makefile, Dockerfile, etc.
  return "binary"
}
