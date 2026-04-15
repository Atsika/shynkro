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

/**
 * Three-way merge: base → local (local changes), base → server (server changes).
 *
 * Auto-merges non-conflicting changes (only one side changed a region).
 * Produces conflict hunks only where BOTH sides changed the same base region
 * to different values.
 *
 * Falls back to `buildConflictText` (2-way) when base is empty or the text is
 * too large for LCS.
 */
export function buildConflictText3way(
  baseText: string,
  localText: string,
  serverText: string,
): ConflictBuildResult {
  if (localText === serverText) return { text: localText, hunks: [] }
  if (!baseText) return buildConflictText(localText, serverText)

  const base = baseText.split("\n")
  const aLines = localText.split("\n")
  const bLines = serverText.split("\n")

  if (
    base.length > MAX_LINES_FOR_LCS ||
    aLines.length > MAX_LINES_FOR_LCS ||
    bLines.length > MAX_LINES_FOR_LCS
  ) {
    return buildConflictText(localText, serverText)
  }

  // Compute each side's changes relative to base
  const aHunks = computeLineDiff(base, aLines)   // base → local
  const bHunks = computeLineDiff(base, bLines)   // base → server

  if (aHunks.length === 0) return { text: serverText, hunks: [] }
  if (bHunks.length === 0) return { text: localText, hunks: [] }

  // Annotate each change with its side and group overlapping changes
  type Change = { side: "A" | "B"; baseStart: number; baseEnd: number; newLines: string[] }
  const changes: Change[] = [
    ...aHunks.map(h => ({ side: "A" as const, baseStart: h.localStart, baseEnd: h.localEnd, newLines: h.serverLines })),
    ...bHunks.map(h => ({ side: "B" as const, baseStart: h.localStart, baseEnd: h.localEnd, newLines: h.serverLines })),
  ].sort((x, y) => x.baseStart - y.baseStart || (x.side < y.side ? -1 : 1))

  const out: string[] = []
  const meta: ConflictHunkMeta[] = []
  let hunkIndex = 0
  let basePos = 0
  let ci = 0

  while (ci < changes.length) {
    const c = changes[ci]

    // Unchanged base lines before this group
    for (let i = basePos; i < c.baseStart; i++) out.push(base[i])
    basePos = c.baseStart

    // Collect all changes that overlap with each other into one group
    const group: Change[] = [c]
    let groupEnd = c.baseEnd
    ci++
    while (ci < changes.length && changes[ci].baseStart < groupEnd) {
      groupEnd = Math.max(groupEnd, changes[ci].baseEnd)
      group.push(changes[ci])
      ci++
    }

    const hasA = group.some(g => g.side === "A")
    const hasB = group.some(g => g.side === "B")

    // Apply one side's changes to base[basePos..groupEnd] to get a "view"
    const applyChanges = (side: "A" | "B"): string[] => {
      const view: string[] = []
      let pos = basePos
      for (const g of group) {
        if (g.side !== side) continue
        for (let i = pos; i < g.baseStart; i++) view.push(base[i])
        for (const l of g.newLines) view.push(l)
        pos = g.baseEnd
      }
      for (let i = pos; i < groupEnd; i++) view.push(base[i])
      return view
    }

    if (hasA && !hasB) {
      // Only local changed — auto-merge
      for (const l of applyChanges("A")) out.push(l)
    } else if (hasB && !hasA) {
      // Only server changed — auto-merge
      for (const l of applyChanges("B")) out.push(l)
    } else {
      // Both sides changed this region — genuine conflict
      const aView = applyChanges("A")
      const bView = applyChanges("B")

      if (aView.join("\n") === bView.join("\n")) {
        // Same result on both sides — auto-merge
        for (const l of aView) out.push(l)
      } else {
        const localStart = out.length
        for (const l of aView) out.push(l)
        const localEnd = out.length
        const serverStart = out.length
        for (const l of bView) out.push(l)
        const serverEnd = out.length
        meta.push({
          hunkIndex: hunkIndex++,
          localRange: { start: localStart, end: localEnd },
          serverRange: { start: serverStart, end: serverEnd },
        })
      }
    }

    basePos = groupEnd
  }

  // Remaining unchanged base lines
  for (let i = basePos; i < base.length; i++) out.push(base[i])

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
