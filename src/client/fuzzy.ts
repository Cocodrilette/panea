/**
 * Fuzzy matching for the jump-to-pane picker. A query matches a text when its
 * characters appear in it in order (a subsequence); the score rewards the
 * matches a person means when typing a few letters — the start of the text,
 * the start of a word, runs of consecutive characters — and charges for gaps.
 */

export interface Match {
  score: number
  /** Indexes into the text of the matched characters, for highlighting. */
  positions: number[]
}

const BONUS_FIRST = 12
const BONUS_WORD = 8
const BONUS_RUN = 6
const PENALTY_GAP = 1
/** Gaps longer than this cost no more: "a…z" across a long path is still a match. */
const MAX_GAP = 8

const SEPARATORS = new Set([' ', '/', '-', '_', '.', ':', '@', '%', '—'])

/**
 * Best subsequence alignment of `query` in `text`, or null when there is none.
 * Greedy from each place the first character occurs, keeping the best: the
 * leftmost greedy alignment alone would pick "s" in "tests/src" for "src".
 */
export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return { score: 0, positions: [] }

  let best: Match | null = null
  for (let start = t.indexOf(q[0]); start !== -1; start = t.indexOf(q[0], start + 1)) {
    const m = alignFrom(q, t, text, start)
    if (!m) break // no later start can complete the query either
    if (!best || m.score > best.score) best = m
  }
  return best
}

function alignFrom(q: string, t: string, raw: string, start: number): Match | null {
  const positions: number[] = []
  let score = 0
  let prev = -2
  let i = start
  for (const ch of q) {
    // Prefer the next word-start occurrence over a mid-word one when both
    // come before the query needs to move on — "cs" in "canvas-server" wants
    // the "s" of "server", not the one in "canvas".
    const next = t.indexOf(ch, i)
    if (next === -1) return null
    let at = next
    if (positions.length && next !== prev + 1 && !isWordStart(raw, next)) {
      for (let j = next + 1; j < t.length && j - next <= MAX_GAP; j++) {
        if (t[j] === ch && isWordStart(raw, j)) {
          at = j
          break
        }
      }
    }

    if (at === 0) score += BONUS_FIRST
    else if (isWordStart(raw, at)) score += BONUS_WORD
    if (at === prev + 1) score += BONUS_RUN
    else if (prev >= 0) score -= Math.min(MAX_GAP, at - prev - 1) * PENALTY_GAP

    positions.push(at)
    prev = at
    i = at + 1
  }
  // Among equal alignments, the shorter text is the tighter match.
  score -= t.length / 100
  return { score, positions }
}

function isWordStart(raw: string, i: number): boolean {
  if (i === 0) return true
  const before = raw[i - 1]
  if (SEPARATORS.has(before)) return true
  // camelCase boundary.
  return before === before.toLowerCase() && raw[i] !== raw[i].toLowerCase()
}

export interface Field {
  text: string
  /** How much a match here counts against a match in another field. */
  weight: number
}

export interface Ranked<T> {
  item: T
  score: number
  /** Matched positions per field index. */
  hits: Map<number, number[]>
}

/**
 * Rank `items` against a query of space-separated terms. Every term must
 * match some field — "api logs" finds the logs pane of the api session — and
 * each term counts once, in the field where it matches best.
 */
export function rank<T>(items: T[], query: string, fields: (item: T) => Field[]): Ranked<T>[] {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  const out: Ranked<T>[] = []

  for (const item of items) {
    const fs = fields(item)
    const hits = new Map<number, number[]>()
    let score = 0
    let ok = true

    for (const term of terms) {
      let bestScore = -Infinity
      let bestField = -1
      let bestPos: number[] = []
      fs.forEach((f, idx) => {
        const m = fuzzyMatch(term, f.text)
        if (!m) return
        const s = m.score * f.weight
        if (s > bestScore) {
          bestScore = s
          bestField = idx
          bestPos = m.positions
        }
      })
      if (bestField === -1) {
        ok = false
        break
      }
      score += bestScore
      hits.set(bestField, [...(hits.get(bestField) ?? []), ...bestPos])
    }

    if (ok) out.push({ item, score, hits })
  }

  return out.sort((a, b) => b.score - a.score)
}

/** `text` as a fragment with the characters at `positions` wrapped in <mark>. */
export function highlight(text: string, positions: number[] | undefined): DocumentFragment {
  const frag = document.createDocumentFragment()
  if (!positions?.length) {
    frag.append(text)
    return frag
  }
  const set = new Set(positions)
  let run = ''
  let marked = false
  const flush = () => {
    if (!run) return
    if (marked) {
      const m = document.createElement('mark')
      m.textContent = run
      frag.append(m)
    } else {
      frag.append(run)
    }
    run = ''
  }
  for (let i = 0; i < text.length; i++) {
    const on = set.has(i)
    if (on !== marked) {
      flush()
      marked = on
    }
    run += text[i]
  }
  flush()
  return frag
}
