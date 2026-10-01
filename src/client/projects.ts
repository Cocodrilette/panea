/**
 * Save, export and import the canvas as tmuxinator projects.
 *
 * The server does the tmuxinator side (see server/tmuxinator.ts); this is the
 * ⋯ menu section and the dialog that decides which sessions go into which
 * project. Giving several sessions the same project name folds them into one
 * — handy for the one-pane sessions the canvas spawns.
 */
import './projects.css'

import type { CanvasBlock, ClientMessage, Layout, ProjectFile, ServerMessage } from '../shared/protocol.ts'

export interface ProjectsHost {
  /** Sessions on the canvas, with a window name to suggest for canvas-made ones. */
  sessions(): { session: string; window: string }[]
  layout(): Layout
  send(msg: ClientMessage): void
  toast(message: string, kind?: 'info' | 'warn' | 'error'): void
  /** Place a project's tiles (see `canvas` in ServerMessage). */
  apply(session: string, canvas: CanvasBlock): void
  /** The ⋯ menu the actions live in; a dialog or file picker replaces it. */
  closeMenu(): void
}

/** Sessions the canvas spawned are named `tcvsh_<time>`: no name for a project. */
const SPAWNED = /^tcvsh_/
const NAME = /^[\w.-]+$/

type Pending = Extract<ClientMessage, { type: 'export-projects' | 'import-projects' }>

export class Projects {
  private known: string[] = []
  /** The request a conflict answer refers to, so it can be sent again. */
  private pending: Pending | null = null
  private silence: number | undefined
  private readonly select = document.getElementById('projects') as HTMLSelectElement
  private readonly file = document.getElementById('projects-file') as HTMLInputElement
  private readonly dialog: HTMLDialogElement

  constructor(private readonly host: ProjectsHost) {
    this.dialog = document.createElement('dialog')
    this.dialog.className = 'projects-dialog'
    document.body.append(this.dialog)

    this.select.addEventListener('change', () => {
      const name = this.select.value
      this.select.value = ''
      if (!name) return
      host.toast(`starting ${name}…`)
      host.send({ type: 'start-project', name })
    })
    const on = (id: string, fn: () => void) =>
      document.getElementById(id)?.addEventListener('click', () => {
        host.closeMenu()
        fn()
      })
    on('projects-save', () => this.open('disk'))
    on('projects-export', () => this.open('download'))
    on('projects-import', () => this.file.click())
    this.file.addEventListener('change', () => void this.importFiles())
  }

  /** Server messages this module owns; false for everything else. */
  handle(msg: ServerMessage): boolean {
    switch (msg.type) {
      case 'projects':
        this.fill(msg.projects)
        return true
      case 'canvas':
        this.host.apply(msg.session, msg.canvas)
        return true
      case 'exported':
        this.settle()
        this.exported(msg.target, msg.files)
        msg.warnings.forEach((w) => this.host.toast(w, 'warn'))
        return true
      case 'imported':
        this.settle()
        this.host.toast(`imported and started: ${msg.names.join(', ')}`)
        return true
      case 'project-conflict':
        this.conflict(msg.names)
        return true
      case 'error':
        // Shown by main.ts; it still answers whatever was pending.
        this.settle()
        return false
      default:
        return false
    }
  }

  fill(projects: string[]): void {
    this.known = projects
    this.select.textContent = ''
    const head = document.createElement('option')
    head.value = ''
    head.textContent = 'Start…'
    this.select.append(head)
    for (const name of projects) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      this.select.append(opt)
    }
  }

  /* --------------------------------- export -------------------------------- */

  private suggest(session: string, window: string): string {
    if (!SPAWNED.test(session) && NAME.test(session)) return session
    return window.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'canvas'
  }

  private open(target: 'disk' | 'download'): void {
    const sessions = this.host.sessions()
    if (!sessions.length) {
      this.host.toast('there are no sessions on the canvas', 'warn')
      return
    }

    const d = this.dialog
    d.textContent = ''
    const title = document.createElement('h2')
    title.textContent = target === 'disk' ? 'Save to tmuxinator' : 'Export projects'
    const intro = document.createElement('p')
    intro.className = 'projects-intro'
    intro.textContent =
      'Each session is written as a tmuxinator project, with its positions and groups under the canvas key. ' +
      'If the project already exists, only that block is updated. Sessions with the same name are merged into one project.'

    const list = document.createElement('div')
    list.className = 'projects-list'
    const rows: { session: string; check: HTMLInputElement; name: HTMLInputElement; note: HTMLSpanElement }[] = []

    const refresh = () => {
      const counts = new Map<string, number>()
      for (const r of rows) if (r.check.checked) counts.set(r.name.value, (counts.get(r.name.value) ?? 0) + 1)
      for (const r of rows) {
        const name = r.name.value.trim()
        const valid = NAME.test(name)
        r.name.classList.toggle('invalid', r.check.checked && !valid)
        r.note.textContent = !r.check.checked
          ? ''
          : !valid
            ? 'invalid name'
            : (counts.get(name) ?? 0) > 1
              ? this.known.includes(name)
                ? 'merges · replaces'
                : 'merges'
              : this.known.includes(name)
                ? name === r.session
                  ? 'updates'
                  : 'replaces'
                : 'new'
      }
      submit.disabled = !rows.some((r) => r.check.checked) || rows.some((r) => r.check.checked && !NAME.test(r.name.value.trim()))
    }

    for (const { session, window } of sessions) {
      const row = document.createElement('label')
      row.className = 'projects-row'
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = true
      const label = document.createElement('span')
      label.className = 'projects-session'
      label.textContent = session
      label.title = session
      const name = document.createElement('input')
      name.type = 'text'
      name.value = this.suggest(session, window)
      name.spellcheck = false
      name.addEventListener('input', refresh)
      check.addEventListener('change', refresh)
      const note = document.createElement('span')
      note.className = 'projects-note'
      row.append(check, label, name, note)
      list.append(row)
      rows.push({ session, check, name, note })
    }

    const actions = document.createElement('div')
    actions.className = 'projects-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => d.close())
    const submit = document.createElement('button')
    submit.type = 'button'
    submit.className = 'primary'
    submit.textContent = target === 'disk' ? 'Save' : 'Download'
    submit.addEventListener('click', () => {
      const map: Record<string, string> = {}
      for (const r of rows) if (r.check.checked) map[r.session] = r.name.value.trim()
      d.close()
      this.request({ type: 'export-projects', sessions: map, layout: this.host.layout(), target })
    })
    actions.append(cancel, submit)

    d.append(title, intro, list, actions)
    refresh()
    d.showModal()
    submit.focus()
  }

  private exported(target: 'disk' | 'download', files: ProjectFile[]): void {
    if (!files.length) return
    const names = files.map((f) => `${f.name}.yml`).join(', ')
    if (target === 'disk') {
      this.host.toast(`saved to tmuxinator: ${names}`)
      return
    }
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.text], { type: 'application/x-yaml' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${f.name}.yml`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }
    this.host.toast(`downloaded: ${names}`)
  }

  /* --------------------------------- import -------------------------------- */

  private async importFiles(): Promise<void> {
    const files = [...(this.file.files ?? [])]
    this.file.value = ''
    if (!files.length) return
    const read = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
    this.host.toast(read.length === 1 ? `importing ${read[0].name}…` : `importing ${read.length} projects…`)
    this.request({ type: 'import-projects', files: read })
  }

  /* -------------------------------- conflicts ------------------------------- */

  private request(msg: Pending): void {
    this.pending = msg
    this.host.send(msg)
    // A server from before this feature drops the message without a word, and
    // the menu then just looks broken.
    clearTimeout(this.silence)
    this.silence = setTimeout(() => {
      if (this.pending !== msg) return
      this.pending = null
      this.host.toast(
        'the server didn\'t answer. If you updated it recently, restart it (npm run autostart or npm start).',
        'error',
      )
    }, 20_000) as unknown as number
  }

  /** Any answer to the pending request, good or bad, ends the wait. */
  private settle(): Pending | null {
    clearTimeout(this.silence)
    const msg = this.pending
    this.pending = null
    return msg
  }

  private conflict(names: string[]): void {
    const msg = this.settle()
    if (!msg) return
    const list = names.map((n) => `${n}.yml`).join(', ')
    const ok = confirm(
      `${list} already exist${names.length > 1 ? '' : 's'} in tmuxinator.\n\nReplace ${names.length > 1 ? 'them' : 'it'}? ` +
        'Anything written by hand (commands, comments) is lost.',
    )
    if (!ok) return
    this.request({ ...msg, overwrite: [...(msg.overwrite ?? []), ...names] })
  }
}
