/**
 * Groups: a labeled frame behind tiles that belong together.
 *
 * Every tile starts in its tmux session's group (`s:<session>`), so a fresh
 * canvas is framed the way tmuxinator laid it out. From there the groups are
 * the user's: drag a tile into another frame to move it there, drag it out
 * of its own to ungroup it, shift-select tiles to make a new group, rename or
 * recolor a group from its header. Only the deviations from "one group per
 * session" are persisted (`layout.groupOf`, `layout.groups`), so a pane that
 * shows up later still lands in its session's group.
 *
 * A frame has no position of its own — it is always the padded bounding box
 * of its tiles. Moving a frame moves its tiles, and the tiles' boxes are what
 * the layout already saves.
 */
import type { GroupDef, Layout, TileBox } from '../shared/protocol.ts'
import type { Tile } from './tile.ts'

/** Room around the tiles, in world px. */
const PAD = 18
/** Header strip above the tiles, in world px at 100% zoom. */
const HEAD = 34
/**
 * Below 100% the header and its label grow in world units so they keep the
 * same size on screen: zoomed out is exactly when the frames are what you
 * navigate by.
 */
const MAX_LABEL_SCALE = 1 / 0.12
/**
 * Past this zoom (main.ts's LOD threshold) a grown label no longer fits in
 * the gap above its tiles and would hide under a neighbouring group's, so the
 * headers are lifted above the tiles — which by then are only snapshots.
 */
const FAR_ZOOM = 0.55
/** How far past the rest of its group a dragged tile must go to leave it. */
const LEAVE_MARGIN = 48
/** The swatches offered in a group's color menu. */
const HUES = [210, 175, 140, 95, 45, 20, 350, 300, 265]

export interface GroupHost {
  /** Live world scale, to turn a pointer delta into world px. */
  zoom(): number
  toWorld(sx: number, sy: number): { x: number; y: number }
  /** The live layout; `init` replaces the object, so it is read every time. */
  layout(): Layout
  /** Membership, names or tile positions changed; persist them. */
  save(): void
  /**
   * Smart guides for a frame being dragged: where `rect` should land among
   * `others`. `free` (⌥ held) skips snapping for that move.
   */
  snapFrame(rect: Rect, others: Rect[], free: boolean): { x: number; y: number }
  /** The frame drag ended: take the guides down. */
  snapEnd(): void
}

interface Frame {
  el: HTMLDivElement
  label: HTMLSpanElement
  count: HTMLSpanElement
  members: Tile[]
}

type Rect = { x: number; y: number; w: number; h: number }

/** What letting go of a dragged tile right now would do to its membership. */
type DropIntent = { kind: 'join'; gid: string } | { kind: 'leave'; gid: string } | null

interface DragState {
  tile: Tile
  own: string
  /** Padded frames of every other group, frozen when the drag starts. */
  others: { gid: string; rect: Rect }[]
  /** The rest of the tile's own group; null when it is alone in it. */
  rest: Rect | null
  intent: DropIntent
}

export class Groups {
  private readonly frames = new Map<string, Frame>()
  private readonly selected = new Set<Tile>()
  private readonly observer: MutationObserver
  private readonly bar: HTMLDivElement
  private readonly hint: HTMLDivElement
  private menu: HTMLDivElement | null = null
  private menuCleanup: (() => void) | null = null
  private drag: DragState | null = null
  private queued = false

  constructor(
    private readonly root: HTMLElement,
    private readonly world: HTMLElement,
    private readonly tiles: () => Iterable<Tile>,
    private readonly host: GroupHost,
  ) {
    // Tiles don't announce their moves, but every one of them — drag,
    // resize, tmux's geometry reply, a repack — ends in a write to the tile's
    // inline style, and adding or removing one is a child of the world. So
    // the frames watch for exactly that instead of every caller remembering
    // to tell them. Only the tile elements themselves are observed: the
    // terminals inside repaint constantly and must not wake this up.
    this.observer = new MutationObserver((records) => {
      if (records.some((r) => r.type === 'childList' && r.target === this.world)) this.observeTiles()
      this.schedule()
    })
    this.observer.observe(world, { childList: true })
    this.observeTiles()
    this.setZoom(host.zoom())

    this.bar = this.buildBar()
    this.hint = document.createElement('div')
    this.hint.className = 'group-drop-hint'
    this.hint.hidden = true
    document.body.append(this.bar, this.hint)

    this.wireSelection()
  }

  /** Keep the label legible on screen when zoomed out. */
  setZoom(zoom: number): void {
    const s = Math.min(MAX_LABEL_SCALE, Math.max(1, 1 / zoom))
    this.world.style.setProperty('--group-scale', String(s))
    this.world.toggleAttribute('data-groups-far', zoom < FAR_ZOOM)
  }

  /** The layout was replaced (a reconnect): draw it again. */
  refresh(): void {
    this.schedule()
  }

  /** Group id of a tile: an explicit assignment, else its session's. '' is none. */
  groupOf(tile: Tile): string {
    const layout = this.host.layout()
    const gid = layout.groupOf?.[tile.spec.id]
    if (gid === undefined) return `s:${tile.spec.session}`
    // An assignment to a custom group that has since been deleted.
    if (gid.startsWith('g:') && !layout.groups?.[gid]) return ''
    return gid
  }

  /* ------------------------------ membership ------------------------------ */

  private def(gid: string): GroupDef | undefined {
    return this.host.layout().groups?.[gid]
  }

  private nameOf(gid: string): string {
    return this.def(gid)?.name ?? (gid.startsWith('s:') ? gid.slice(2) : 'group')
  }

  private hueFor(gid: string): number {
    return this.def(gid)?.hue ?? hueOf(gid.startsWith('s:') ? gid.slice(2) : gid)
  }

  private assign(list: Iterable<Tile>, gid: string): void {
    const layout = this.host.layout()
    const map = (layout.groupOf ??= {})
    for (const tile of list) {
      // Back in its own session's group is the default, not a deviation.
      if (gid === `s:${tile.spec.session}`) delete map[tile.spec.id]
      else map[tile.spec.id] = gid
    }
    this.pruneEmpty()
    this.commit()
  }

  private createGroup(list: Tile[]): string {
    const layout = this.host.layout()
    const defs = (layout.groups ??= {})
    const taken = new Set([...this.frames.keys()].map((g) => this.nameOf(g)))
    let n = 1
    while (taken.has(`group ${n}`)) n++
    const gid = `g:${Date.now().toString(36)}`
    defs[gid] = { name: `group ${n}`, hue: HUES[Object.keys(defs).length % HUES.length] }
    this.assign(list, gid)
    return gid
  }

  /** Everyone out: members end up ungrouped, and a custom group is gone. */
  private dissolve(gid: string): void {
    const members = this.frames.get(gid)?.members ?? []
    const layout = this.host.layout()
    const map = (layout.groupOf ??= {})
    for (const tile of members) map[tile.spec.id] = ''
    if (gid.startsWith('g:') && layout.groups) delete layout.groups[gid]
    this.commit()
  }

  /** A custom group nobody is in anymore is not worth keeping. */
  private pruneEmpty(): void {
    const layout = this.host.layout()
    if (!layout.groups) return
    const used = new Set(Object.values(layout.groupOf ?? {}))
    for (const gid of Object.keys(layout.groups)) {
      if (gid.startsWith('g:') && !used.has(gid)) delete layout.groups[gid]
    }
  }

  private setDef(gid: string, patch: GroupDef): void {
    const layout = this.host.layout()
    const defs = (layout.groups ??= {})
    defs[gid] = { ...defs[gid], ...patch }
    this.commit()
  }

  private commit(): void {
    this.host.save()
    this.render()
  }

  /* -------------------------------- render -------------------------------- */

  private observeTiles(): void {
    for (const tile of this.tiles()) this.observer.observe(tile.el, { attributes: true, attributeFilter: ['style'] })
  }

  private schedule(): void {
    if (this.queued) return
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.render()
    })
  }

  private render(): void {
    const byGroup = this.grouped()
    const live = new Set(this.tiles())

    for (const tile of this.selected) if (!live.has(tile)) this.selected.delete(tile)
    this.renderBar()

    for (const [gid, frame] of this.frames) {
      if (byGroup.has(gid)) continue
      frame.el.remove()
      this.frames.delete(gid)
    }

    for (const [gid, list] of byGroup) {
      const frame = this.frames.get(gid) ?? this.create(gid)
      frame.members = list
      const b = boundsOf(list.map((t) => t.box))
      const { style } = frame.el
      // left/top, not a transform like the tiles: a transform would make the
      // frame a stacking context and keep its header from rising above them.
      style.left = `${b.x - PAD}px`
      style.top = `${b.y - PAD - HEAD}px`
      style.width = `${b.w + PAD * 2}px`
      style.height = `${b.h + PAD * 2 + HEAD}px`
      style.setProperty('--group-hue', String(this.hueFor(gid)))
      if (!frame.label.querySelector('input')) frame.label.textContent = this.nameOf(gid)
      frame.count.textContent = list.length === 1 ? '1 pane' : `${list.length} panes`
    }

    for (const tile of live) this.renderChip(tile)
  }

  /** Grouped tiles by group id; ungrouped tiles have no frame. */
  private grouped(): Map<string, Tile[]> {
    const out = new Map<string, Tile[]>()
    for (const tile of this.tiles()) {
      const gid = this.groupOf(tile)
      if (!gid) continue
      const list = out.get(gid)
      if (list) list.push(tile)
      else out.set(gid, [tile])
    }
    return out
  }

  private create(gid: string): Frame {
    const el = document.createElement('div')
    el.className = 'group-frame'
    el.dataset.group = gid

    const head = document.createElement('div')
    head.className = 'group-head'
    head.title = 'Drag to move the group · double-click to rename'
    const label = document.createElement('span')
    label.className = 'group-label'
    const count = document.createElement('span')
    count.className = 'group-count'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'group-more'
    more.title = 'Edit group'
    more.textContent = '⋯'
    more.addEventListener('pointerdown', (e) => e.stopPropagation())
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      const r = more.getBoundingClientRect()
      this.openGroupMenu(gid, r.left, r.bottom + 4)
    })
    head.append(label, count, more)
    el.append(head)

    head.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.rename(gid)
    })
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.openGroupMenu(gid, e.clientX, e.clientY)
    })
    this.wireDrag(head, gid)
    // Before the tiles, so equal z-indexes still paint the frame underneath.
    this.world.prepend(el)
    const frame = { el, label, count, members: [] }
    this.frames.set(gid, frame)
    return frame
  }

  /** The group chip in a tile's title bar: its color, its name, its menu. */
  private renderChip(tile: Tile): void {
    let chip = tile.el.querySelector<HTMLButtonElement>('.tile-group')
    if (!chip) {
      chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'tile-group'
      chip.title = 'Change group'
      chip.addEventListener('pointerdown', (e) => e.stopPropagation())
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        const r = chip!.getBoundingClientRect()
        this.openMoveMenu([tile], r.left, r.bottom + 4)
      })
      // Ahead of the tile's own buttons, after its title and badges.
      tile.el.querySelector('.tile-head button')?.before(chip)
    }
    const gid = this.groupOf(tile)
    chip.textContent = gid ? this.nameOf(gid) : 'no group'
    chip.classList.toggle('none', !gid)
    if (gid) chip.style.setProperty('--group-hue', String(this.hueFor(gid)))
  }

  /* --------------------------------- drag --------------------------------- */

  /** Dragging the header drags every tile of the group by the same delta. */
  private wireDrag(head: HTMLElement, gid: string): void {
    head.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || (ev.target as HTMLElement).closest('input')) return
      // Neither a pan of the canvas nor a blur of the focused tile.
      ev.stopPropagation()
      head.setPointerCapture(ev.pointerId)
      head.classList.add('dragging')

      const members = this.frames.get(gid)?.members ?? []
      if (!members.length) return
      const origin = members.map((t) => ({ tile: t, x: t.box.x, y: t.box.y }))
      const start = { x: ev.clientX, y: ev.clientY }
      const scale = this.host.zoom()
      // The frame snaps as a whole, to the other frames and to ungrouped
      // tiles, which are the only things standing on their own next to it.
      const from = grow(boundsOf(members.map((t) => t.box)), PAD)
      const others = this.snapTargets(gid)

      const move = (e: PointerEvent) => {
        const raw = { ...from, x: from.x + (e.clientX - start.x) / scale, y: from.y + (e.clientY - start.y) / scale }
        const at = this.host.snapFrame(raw, others, e.altKey)
        const dx = at.x - from.x
        const dy = at.y - from.y
        for (const o of origin) {
          o.tile.box.x = Math.round(o.x + dx)
          o.tile.box.y = Math.round(o.y + dy)
          o.tile.applyBox()
        }
      }
      const up = () => {
        this.host.snapEnd()
        head.classList.remove('dragging')
        head.removeEventListener('pointermove', move)
        head.removeEventListener('pointerup', up)
        head.removeEventListener('pointercancel', up)
        this.host.save()
      }
      head.addEventListener('pointermove', move)
      head.addEventListener('pointerup', up)
      head.addEventListener('pointercancel', up)
    })
  }

  /**
   * A tile is being dragged by its title bar. Over another group's frame it
   * would join that group; far enough from the rest of its own, it would
   * leave it. Both are shown live, and applied by `tileDragEnd`.
   */
  tileDragMove(tile: Tile, sx: number, sy: number): void {
    if (!this.drag || this.drag.tile !== tile) this.drag = this.startTileDrag(tile)
    const d = this.drag
    const p = this.host.toWorld(sx, sy)

    let intent: DropIntent = null
    // The smallest frame under the pointer wins, so a group parked inside a
    // bigger one can still be dropped into.
    const hit = d.others
      .filter(({ rect }) => inside(p, rect))
      .sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h)[0]
    if (hit) intent = { kind: 'join', gid: hit.gid }
    else if (d.own && d.rest && !inside(p, grow(d.rest, LEAVE_MARGIN))) intent = { kind: 'leave', gid: d.own }
    d.intent = intent

    for (const [gid, frame] of this.frames) {
      frame.el.classList.toggle('drop-target', intent?.kind === 'join' && intent.gid === gid)
      frame.el.classList.toggle('drop-leaving', intent?.kind === 'leave' && intent.gid === gid)
    }
    if (intent) {
      this.hint.textContent =
        intent.kind === 'join' ? `drop to move to “${this.nameOf(intent.gid)}”` : `drop to take it out of “${this.nameOf(intent.gid)}”`
      this.hint.style.left = `${sx + 14}px`
      this.hint.style.top = `${sy + 18}px`
    }
    this.hint.hidden = !intent
  }

  tileDragEnd(tile: Tile): void {
    const d = this.drag
    this.drag = null
    this.hint.hidden = true
    for (const frame of this.frames.values()) frame.el.classList.remove('drop-target', 'drop-leaving')
    if (!d || d.tile !== tile || !d.intent) return
    if (d.intent.kind === 'join') this.assign([tile], d.intent.gid)
    else this.assign([tile], '')
  }

  /** Every frame but `gid`'s, plus the tiles that belong to no group. */
  private snapTargets(gid: string): Rect[] {
    const out: Rect[] = []
    for (const [other, frame] of this.frames) {
      if (other !== gid && frame.members.length) out.push(grow(boundsOf(frame.members.map((t) => t.box)), PAD))
    }
    for (const tile of this.tiles()) if (!this.groupOf(tile)) out.push(tile.box)
    return out
  }

  private startTileDrag(tile: Tile): DragState {
    const own = this.groupOf(tile)
    const others: DragState['others'] = []
    let rest: Rect | null = null
    for (const [gid, frame] of this.frames) {
      const list = frame.members.filter((t) => t !== tile)
      if (!list.length) continue
      const b = boundsOf(list.map((t) => t.box))
      if (gid === own) rest = b
      else others.push({ gid, rect: { x: b.x - PAD, y: b.y - PAD - HEAD, w: b.w + PAD * 2, h: b.h + PAD * 2 + HEAD } })
    }
    return { tile, own, others, rest, intent: null }
  }

  /* ------------------------------- selection ------------------------------ */

  private wireSelection(): void {
    // Shift+click on a title bar picks tiles one by one. Captured on the
    // world so it runs before the tile's own drag handler.
    this.world.addEventListener(
      'pointerdown',
      (ev) => {
        if (!ev.shiftKey || ev.button !== 0) return
        const head = (ev.target as HTMLElement).closest('.tile-head')
        if (!head || (ev.target as HTMLElement).closest('button')) return
        const tile = [...this.tiles()].find((t) => t.el.contains(head))
        if (!tile) return
        ev.stopPropagation()
        ev.preventDefault()
        this.toggle(tile)
      },
      true,
    )

    // Shift+drag on the background draws a selection box. Captured on the
    // root, ahead of the viewport's pan.
    this.root.addEventListener(
      'pointerdown',
      (ev) => {
        const onBackground = ev.target === this.root || ev.target === this.world
        if (!onBackground || ev.button !== 0) return
        if (!ev.shiftKey) {
          this.clearSelection()
          return
        }
        ev.stopImmediatePropagation()
        ev.preventDefault()
        this.marquee(ev)
      },
      true,
    )

    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !this.selected.size) return
      if ((ev.target as HTMLElement).classList?.contains('xterm-helper-textarea')) return
      this.clearSelection()
    })
  }

  private marquee(ev: PointerEvent): void {
    const box = document.createElement('div')
    box.className = 'group-marquee'
    document.body.append(box)
    this.root.setPointerCapture(ev.pointerId)
    const start = { x: ev.clientX, y: ev.clientY }
    const before = new Set(this.selected)

    const move = (e: PointerEvent) => {
      const x0 = Math.min(start.x, e.clientX)
      const y0 = Math.min(start.y, e.clientY)
      const x1 = Math.max(start.x, e.clientX)
      const y1 = Math.max(start.y, e.clientY)
      Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` })
      const a = this.host.toWorld(x0, y0)
      const b = this.host.toWorld(x1, y1)
      const rect = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }
      for (const tile of this.tiles()) this.setSelected(tile, before.has(tile) || intersects(tile.box, rect))
      this.renderBar()
    }
    const up = () => {
      box.remove()
      this.root.removeEventListener('pointermove', move)
      this.root.removeEventListener('pointerup', up)
      this.root.removeEventListener('pointercancel', up)
    }
    this.root.addEventListener('pointermove', move)
    this.root.addEventListener('pointerup', up)
    this.root.addEventListener('pointercancel', up)
  }

  private toggle(tile: Tile): void {
    this.setSelected(tile, !this.selected.has(tile))
    this.renderBar()
  }

  private setSelected(tile: Tile, on: boolean): void {
    if (on) this.selected.add(tile)
    else this.selected.delete(tile)
    tile.el.classList.toggle('group-selected', on)
  }

  private clearSelection(): void {
    if (!this.selected.size) return
    for (const tile of this.selected) tile.el.classList.remove('group-selected')
    this.selected.clear()
    this.renderBar()
  }

  private buildBar(): HTMLDivElement {
    const bar = document.createElement('div')
    bar.className = 'group-bar'
    bar.hidden = true
    bar.innerHTML = `
      <span class="group-bar-count"></span>
      <button type="button" data-act="group">Group</button>
      <button type="button" data-act="move">Move to ▾</button>
      <button type="button" data-act="ungroup">Remove from group</button>
      <button type="button" data-act="clear" title="Clear selection (esc)">✕</button>`
    bar.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('button')
      const list = [...this.selected]
      switch (btn?.dataset.act) {
        case 'group': {
          const gid = this.createGroup(list)
          this.clearSelection()
          this.rename(gid)
          break
        }
        case 'move': {
          const r = btn.getBoundingClientRect()
          this.openMoveMenu(list, r.left, r.top - 4, true)
          break
        }
        case 'ungroup':
          this.assign(list, '')
          this.clearSelection()
          break
        case 'clear':
          this.clearSelection()
          break
      }
    })
    return bar
  }

  private renderBar(): void {
    const n = this.selected.size
    this.bar.hidden = n === 0
    const count = this.bar.querySelector('.group-bar-count')
    if (count) count.textContent = n === 1 ? '1 tile' : `${n} tiles`
  }

  /* --------------------------------- menus -------------------------------- */

  /** Where `list` can go: every group on the canvas, a new one, or none. */
  private openMoveMenu(list: Tile[], x: number, y: number, above = false): void {
    const current = new Set(list.map((t) => this.groupOf(t)))
    const menu = this.openMenu(x, y, above)
    for (const gid of [...this.frames.keys()].sort((a, b) => this.nameOf(a).localeCompare(this.nameOf(b)))) {
      this.menuItem(menu, this.nameOf(gid), () => this.assign(list, gid), {
        hue: this.hueFor(gid),
        checked: current.size === 1 && current.has(gid),
      })
    }
    menu.append(separator())
    this.menuItem(menu, '+ New group…', () => {
      const gid = this.createGroup(list)
      this.clearSelection()
      this.rename(gid)
    })
    this.menuItem(menu, 'No group', () => this.assign(list, ''), { checked: current.size === 1 && current.has('') })
    // Each tile back where tmux put it.
    const home = list.some((t) => this.groupOf(t) !== `s:${t.spec.session}`)
    if (home) {
      this.menuItem(menu, 'Back to its tmux session', () => {
        const map = this.host.layout().groupOf ?? {}
        for (const t of list) delete map[t.spec.id]
        this.pruneEmpty()
        this.commit()
      })
    }
  }

  private openGroupMenu(gid: string, x: number, y: number): void {
    const menu = this.openMenu(x, y)
    this.menuItem(menu, 'Rename', () => this.rename(gid))

    const swatches = document.createElement('div')
    swatches.className = 'group-swatches'
    for (const hue of HUES) {
      const s = document.createElement('button')
      s.type = 'button'
      s.style.setProperty('--group-hue', String(hue))
      s.classList.toggle('on', this.hueFor(gid) === hue)
      s.title = 'Group color'
      s.addEventListener('click', () => {
        this.closeMenu()
        this.setDef(gid, { hue })
      })
      swatches.append(s)
    }
    menu.append(swatches)

    this.menuItem(menu, 'Select its tiles', () => {
      this.clearSelection()
      for (const t of this.frames.get(gid)?.members ?? []) this.setSelected(t, true)
      this.renderBar()
    })
    menu.append(separator())
    this.menuItem(menu, 'Dissolve group', () => this.dissolve(gid), { danger: true })
  }

  private openMenu(x: number, y: number, above = false): HTMLDivElement {
    this.closeMenu()
    const menu = document.createElement('div')
    menu.className = 'group-menu'
    document.body.append(menu)
    this.menu = menu
    // Placed after it has a size, so it can be kept on screen.
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect()
      const left = Math.min(x, window.innerWidth - r.width - 8)
      const top = above ? y - r.height : Math.min(y, window.innerHeight - r.height - 8)
      menu.style.left = `${Math.max(8, left)}px`
      menu.style.top = `${Math.max(8, top)}px`
      menu.style.visibility = 'visible'
    })
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e.type === 'pointerdown' && menu.contains(e.target as Node)) return
      this.closeMenu()
    }
    setTimeout(() => {
      window.addEventListener('pointerdown', away, true)
      window.addEventListener('keydown', away, true)
    })
    this.menuCleanup = () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', away, true)
    }
    return menu
  }

  private closeMenu(): void {
    this.menu?.remove()
    this.menu = null
    this.menuCleanup?.()
    this.menuCleanup = null
  }

  private menuItem(
    menu: HTMLElement,
    label: string,
    run: () => void,
    opts: { hue?: number; checked?: boolean; danger?: boolean } = {},
  ): void {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'group-menu-item'
    if (opts.danger) b.classList.add('danger')
    if (opts.checked) b.classList.add('checked')
    if (opts.hue !== undefined) {
      const dot = document.createElement('span')
      dot.className = 'group-dot'
      dot.style.setProperty('--group-hue', String(opts.hue))
      b.append(dot)
    }
    b.append(label)
    b.addEventListener('click', () => {
      this.closeMenu()
      run()
    })
    menu.append(b)
  }

  /** Rename in place: the label turns into a text field. */
  private rename(gid: string): void {
    const frame = this.frames.get(gid)
    if (!frame) return
    const input = document.createElement('input')
    input.className = 'group-rename'
    input.value = this.nameOf(gid)
    input.spellcheck = false
    frame.label.textContent = ''
    frame.label.append(input)
    input.focus()
    input.select()

    let done = false
    const finish = (save: boolean) => {
      if (done) return
      done = true
      const name = input.value.trim()
      input.remove()
      if (save && name && name !== this.nameOf(gid)) this.setDef(gid, { name })
      else this.render()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('pointerdown', (e) => e.stopPropagation())
  }

  /** Group ids for packing: ungrouped tiles each travel alone. */
  packKey(tile: Tile): string {
    return this.groupOf(tile) || `\0${tile.spec.id}`
  }

  /** Sort key for packing: groups by name, loose tiles after them. */
  packOrder(key: string): string {
    return key.startsWith('\0') ? `￿${key}` : this.nameOf(key).toLowerCase()
  }
}

/**
 * Pack tiles group by group: each group's tiles into rows of their own,
 * then the groups side by side, wrapping into rows of groups once a row gets
 * wide. Like the flat pack, positions only — a tile's size belongs to its
 * tmux pane. Mutates the boxes; the caller applies them.
 */
export function packByGroup(tiles: Iterable<Tile>, gap: number, groups: Groups): void {
  const byKey = new Map<string, Tile[]>()
  for (const tile of tiles) {
    const key = groups.packKey(tile)
    const list = byKey.get(key)
    if (list) list.push(tile)
    else byKey.set(key, [tile])
  }
  const packed = [...byKey]
    .sort(([a], [b]) => groups.packOrder(a).localeCompare(groups.packOrder(b)))
    .map(([, list]) => packRows(list, gap))
  if (!packed.length) return

  // Between two groups sit both frames' padding and header, plus the gap.
  const gapX = PAD * 2 + gap * 2
  const gapY = PAD * 2 + HEAD + gap * 2
  // Aim for a landscape canvas — wider than the screen's 16:10, since rows of
  // uneven groups leave holes — but never narrower than the widest group.
  const area = packed.reduce((sum, g) => sum + (g.w + gapX) * (g.h + gapY), 0)
  const rowWidth = Math.max(...packed.map((g) => g.w), Math.sqrt(area * 2.4))

  let x = 0
  let y = 0
  let rowHeight = 0
  for (const g of packed) {
    if (x > 0 && x + g.w > rowWidth) {
      x = 0
      y += rowHeight + gapY
      rowHeight = 0
    }
    for (const tile of g.list) {
      tile.box.x += x
      tile.box.y += y
    }
    x += g.w + gapX
    rowHeight = Math.max(rowHeight, g.h)
  }
}

/** One group's tiles in rows at the origin, to learn its footprint. */
function packRows(list: Tile[], gap: number): Rect & { list: Tile[] } {
  list.sort((a, b) => a.spec.id.localeCompare(b.spec.id))
  const perRow = Math.min(3, Math.ceil(Math.sqrt(list.length)))
  const maxRowWidth = Math.max(...list.map((t) => t.box.w)) * perRow + gap * (perRow - 1)
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const tile of list) {
    if (x > 0 && x + tile.box.w > maxRowWidth) {
      x = 0
      y += rowHeight + gap
      rowHeight = 0
    }
    tile.box.x = x
    tile.box.y = y
    x += tile.box.w + gap
    rowHeight = Math.max(rowHeight, tile.box.h)
  }
  return { list, ...boundsOf(list.map((t) => t.box)) }
}

function boundsOf(boxes: TileBox[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function inside(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function grow(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by - HEAD, w: r.w + by * 2, h: r.h + by * 2 + HEAD }
}

function separator(): HTMLElement {
  const hr = document.createElement('div')
  hr.className = 'group-menu-sep'
  return hr
}

/**
 * A stable hue per session name, so a session keeps its tint across reloads.
 * FNV-1a, then spread by the golden angle: tmuxinator names like `api-1` and
 * `api-2` differ in one character and would otherwise land on the same hue.
 */
function hueOf(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0
  return Math.round((h * 137.508) % 360)
}
