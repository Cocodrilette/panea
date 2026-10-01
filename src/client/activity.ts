import type { Tile } from './tile.ts'

/**
 * Activity and attention on tiles: which terminals changed while you were
 * looking elsewhere, which rang the bell, and which went quiet on something
 * that looks like a question.
 *
 * It lives entirely in the client. Every tile already receives its pane's
 * output and keeps an xterm buffer to read the last lines from, so the server
 * has nothing to add — and keeping it here means tmux stays untouched.
 */

/** A fresh tile gets its screen repainted from capture-pane: that is not news. */
const WARMUP_MS = 2500
/** A resize makes most TUIs redraw everything; that is not news either. */
const RESIZE_MUTE_MS = 900
/** Neither is the redraw some apps do when they notice they lost focus. */
const BLUR_MUTE_MS = 900
/** Quiet this long before the last lines are read for a question. */
const QUIET_MS = 1500
/** Quiet this long after output and a tile goes from "live" to "idle". */
const IDLE_MS = 5000
const TICK_MS = 1000
/** How far up from the bottom of the screen a prompt is looked for. */
const TAIL_LINES = 14

export type ActivityState = 'attention' | 'bell' | 'unread' | 'idle'

/** Lower is more urgent: the order ⌘J visits tiles in. */
const RANK: Record<ActivityState, number> = { attention: 0, bell: 1, idle: 2, unread: 3 }

const LABEL: Record<ActivityState, string> = {
  attention: 'needs input',
  bell: 'bell',
  unread: 'new output',
  idle: 'quiet',
}

const HINT: Record<ActivityState, string> = {
  attention: 'Went quiet on something that looks like a question or an approval prompt',
  bell: 'Rang the bell (BEL) since you last looked',
  unread: 'Has been writing output since you last looked',
  idle: 'Had new output and has been quiet for a while',
}

/**
 * Lines that only ever show up while a program is waiting for an answer. Kept
 * narrow on purpose: a false "needs attention" trains you to ignore it. Claude
 * Code's approval dialog is the case that matters most ("Do you want to
 * proceed?" over a "❯ 1. Yes" menu, "Esc to cancel" at the foot).
 */
const WAITING_ANYWHERE = [
  /\bDo you want to (proceed|make this edit|create|run|allow|overwrite|delete|continue)\b/i,
  /[❯›]\s*1\.\s+Yes\b/,
  /\bEsc to cancel\b/,
  /\bPress (Enter|any key|RETURN) to continue\b/i,
]

/** Only on the line the cursor sits on: shells and REPLs asking something. */
const WAITING_AT_CURSOR = [
  /[[(]\s*y(es)?\s*\/\s*n(o)?\s*[\])]\s*[:?]?\s*$/i,
  /\b(password|passphrase|contraseña)\b[^:]*:\s*$/i,
  /\?\s*$/,
]

interface Entry {
  tile: Tile
  unread: boolean
  bell: boolean
  attention: boolean
  /** Output since the last focus that has not been read for a question yet. */
  unchecked: boolean
  lastOutput: number
  warmUntil: number
  muteUntil: number
  /** When the current state began, to visit the oldest first. */
  since: number
  shown: ActivityState | null
  badge: HTMLSpanElement
  far: HTMLDivElement
}

export interface ActivityHooks {
  /** Bring a tile into view and give it the keyboard. */
  jump(tile: Tile): void
  toast(message: string): void
}

export class Activity {
  private readonly entries = new Map<string, Entry>()
  private readonly button: HTMLButtonElement | null
  private lastFocused: Tile | null = null

  constructor(private readonly hooks: ActivityHooks) {
    this.button = document.getElementById('attention-btn') as HTMLButtonElement | null
    this.button?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.next()
    })

    window.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'j' || ev.key === 'J')) {
        ev.preventDefault()
        this.next()
      }
    })

    setInterval(() => this.tick(), TICK_MS)
    this.renderButton()
  }

  track(tile: Tile): void {
    const now = Date.now()

    const badge = document.createElement('span')
    badge.className = 'tile-activity'
    badge.hidden = true
    // Right after the subtitle, so it sits with the other badges.
    tile.el.querySelector('.tile-sub')?.after(badge)

    const far = document.createElement('div')
    far.className = 'tile-activity-far'
    tile.el.appendChild(far)

    const entry: Entry = {
      tile,
      unread: false,
      bell: false,
      attention: false,
      unchecked: false,
      lastOutput: 0,
      warmUntil: now + WARMUP_MS,
      muteUntil: 0,
      since: now,
      shown: null,
      badge,
      far,
    }
    this.entries.set(tile.spec.id, entry)

    // xterm parses escape sequences for us, so the BEL that ends an OSC title
    // never counts as a bell — scanning the raw output for \x07 would.
    tile.term.onBell(() => {
      if (tile.focused || tile.dead || Date.now() < entry.warmUntil) return
      if (!entry.bell) entry.since = Date.now()
      entry.bell = true
      this.render(entry)
    })
  }

  /** A chunk of output reached this tile. */
  output(id: string): void {
    const e = this.entries.get(id)
    if (!e || e.tile.dead) return
    const now = Date.now()
    if (now < e.warmUntil || now < e.muteUntil) return
    e.lastOutput = now
    if (e.tile.focused) return
    if (!e.unread) e.since = now
    e.unread = true
    e.unchecked = true
    // New output means whatever was being asked may have been answered.
    e.attention = false
    this.render(e)
  }

  /** The pane changed size, so a full redraw is on its way. */
  resized(id: string): void {
    const e = this.entries.get(id)
    if (e) e.muteUntil = Date.now() + RESIZE_MUTE_MS
  }

  /** Focus moved to `tile` (or nowhere): everything on it counts as seen. */
  seen(tile: Tile | null): void {
    const prev = this.lastFocused
    this.lastFocused = tile
    if (prev && prev !== tile) {
      const p = this.entries.get(prev.spec.id)
      if (p) p.muteUntil = Math.max(p.muteUntil, Date.now() + BLUR_MUTE_MS)
    }
    const e = tile && this.entries.get(tile.spec.id)
    if (!e) return
    e.unread = e.bell = e.attention = e.unchecked = false
    this.render(e)
  }

  /** Visit the most urgent tile, oldest first; focusing it clears it. */
  next(): void {
    const list = [...this.entries.values()]
      .filter((e) => e.shown && e.tile.el.isConnected)
      .sort((a, b) => RANK[a.shown!] - RANK[b.shown!] || a.since - b.since)
    const target = list[0]
    if (!target) {
      this.hooks.toast('no terminal needs attention')
      return
    }
    this.hooks.jump(target.tile)
  }

  private tick(): void {
    const now = Date.now()
    for (const [id, e] of this.entries) {
      // Tiles are dropped by main.ts in several places; noticing here keeps
      // those paths free of bookkeeping for this module.
      if (!e.tile.el.isConnected) {
        this.entries.delete(id)
        continue
      }
      if (e.unchecked && now - e.lastOutput >= QUIET_MS) {
        e.unchecked = false
        if (!e.tile.focused && looksLikeWaiting(e.tile)) {
          e.attention = true
          e.since = now
        }
      }
      this.render(e)
    }
    this.renderButton()
  }

  private stateOf(e: Entry): ActivityState | null {
    if (e.tile.focused || e.tile.dead) return null
    if (e.attention) return 'attention'
    if (e.bell) return 'bell'
    if (!e.unread) return null
    return Date.now() - e.lastOutput >= IDLE_MS ? 'idle' : 'unread'
  }

  private render(e: Entry): void {
    const state = this.stateOf(e)
    if (state === e.shown) return
    e.shown = state
    if (state) e.tile.el.dataset.activity = state
    else delete e.tile.el.dataset.activity
    e.badge.hidden = !state
    e.badge.textContent = state ? LABEL[state] : ''
    e.badge.title = state ? HINT[state] : ''
    e.far.textContent = state ? LABEL[state] : ''
    this.renderButton()
  }

  private renderButton(): void {
    if (!this.button) return
    let urgent = 0
    let pending = 0
    for (const e of this.entries.values()) {
      if (!e.shown) continue
      pending++
      if (e.shown === 'attention' || e.shown === 'bell') urgent++
    }
    this.button.textContent = `⚑ ${urgent || pending}`
    this.button.classList.toggle('urgent', urgent > 0)
    this.button.classList.toggle('pending', !urgent && pending > 0)
    this.button.title = urgent
      ? `${urgent} terminal(s) need attention — jump to the next (⌘J)`
      : pending
        ? `${pending} terminal(s) with new output — jump to the next (⌘J)`
        : 'No terminal needs attention (⌘J)'
  }
}

/** Read the bottom of the screen for something that is waiting on you. */
function looksLikeWaiting(tile: Tile): boolean {
  const buf = tile.term.buffer.active
  const bottom = buf.baseY + tile.term.rows - 1
  const cursorRow = buf.baseY + buf.cursorY
  const cursorLine = buf.getLine(cursorRow)?.translateToString(true) ?? ''
  if (cursorLine.trim() && WAITING_AT_CURSOR.some((re) => re.test(cursorLine))) return true

  for (let i = bottom, seen = 0; i >= 0 && seen < TAIL_LINES; i--) {
    const line = buf.getLine(i)?.translateToString(true) ?? ''
    if (!line.trim()) continue
    seen++
    if (WAITING_ANYWHERE.some((re) => re.test(line))) return true
  }
  return false
}
