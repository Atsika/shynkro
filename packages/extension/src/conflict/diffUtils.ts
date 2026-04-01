/**
 * Line-level diff utilities for conflict resolution.
 * Returns minimal change hunks between two texts using LCS backtracking.
 */

export interface DiffHunk {
  /** Start line (inclusive) in the local text */
  localStart: number
  /** End line (exclusive) in the local text */
  localEnd: number
  /** Replacement lines from the server */
  serverLines: string[]
}

export interface ConflictHunkMeta {
  hunkIndex: number
  /** Line range in the output buffer for local (mine) lines — [start, end) */
  localRange: { start: number; end: number }
  /** Line range in the output buffer for server (theirs) lines — [start, end) */
  serverRange: { start: number; end: number }
}

export interface ConflictBuildResult {
  text: string
  hunks: ConflictHunkMeta[]
}

/** Files larger than this threshold fall back to a single whole-file conflict block. */
const MAX_LINES_FOR_LCS = 1500

/**
 * Compute change hunks between two texts.
 * Returns an empty array if the texts are identical.
 */
export function computeHunks(localText: string, serverText: string): DiffHunk[] {
  if (localText === serverText) return []

  const a = localText.split("\n")
  const b = serverText.split("\n")

  if (a.length > MAX_LINES_FOR_LCS || b.length > MAX_LINES_FOR_LCS) {
    return [{ localStart: 0, localEnd: a.length, serverLines: b }]
  }

  return computeLineDiff(a, b)
}

/**
 * Build interleaved conflict text with hunk position metadata.
 * Each conflict hunk is rendered as: [local lines] [\u200B separator] [server lines].
 * Unchanged lines appear as-is between hunks.
 */
export function buildConflictText(localText: string, serverText: string): ConflictBuildResult {
  const a = localText.split("\n")
  const hunks = computeHunks(localText, serverText)

  if (hunks.length === 0) return { text: localText, hunks: [] }

  const out: string[] = []
  const meta: ConflictHunkMeta[] = []
  let ai = 0

  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi]

    // Unchanged lines before this hunk
    while (ai < hunk.localStart) out.push(a[ai++])

    const localStart = out.length
    for (let i = hunk.localStart; i < hunk.localEnd; i++) out.push(a[i])
    const localEnd = out.length

    const serverStart = out.length
    for (const line of hunk.serverLines) out.push(line)
    const serverEnd = out.length

    meta.push({
      hunkIndex: hi,
      localRange: { start: localStart, end: localEnd },
      serverRange: { start: serverStart, end: serverEnd },
    })

    ai = hunk.localEnd
  }

  // Remaining unchanged lines
  while (ai < a.length) out.push(a[ai++])

  return { text: out.join("\n"), hunks: meta }
}

// ---------------------------------------------------------------------------
// Internal: LCS-based line diff
// ---------------------------------------------------------------------------

function computeLineDiff(a: string[], b: string[]): DiffHunk[] {
  const n = a.length
  const m = b.length

  // Build LCS table (O(n*m) time and space — guarded by MAX_LINES_FOR_LCS above)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Backtrack to recover matching pairs (lines common to both)
  const matches: Array<{ ai: number; bi: number }> = []
  let i = n, j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      matches.push({ ai: i - 1, bi: j - 1 })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      j--
    } else {
      i--
    }
  }
  matches.reverse()

  // Extract hunks from the gaps between consecutive matches
  const hunks: DiffHunk[] = []

  const addHunk = (aStart: number, aEnd: number, bStart: number, bEnd: number) => {
    if (aStart < aEnd || bStart < bEnd) {
      hunks.push({ localStart: aStart, localEnd: aEnd, serverLines: b.slice(bStart, bEnd) })
    }
  }

  let prevAi = -1, prevBi = -1
  for (const match of matches) {
    addHunk(prevAi + 1, match.ai, prevBi + 1, match.bi)
    prevAi = match.ai
    prevBi = match.bi
  }
  addHunk(prevAi + 1, n, prevBi + 1, m)

  return hunks
}
