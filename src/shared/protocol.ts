/** Wire protocol shared by the control-mode server and the canvas client. */

/**
 * How many lines of history a tile keeps, on both ends: xterm's own
 * scrollback buffer and how far back the server re-captures a pane's
 * content when a browser (re)connects. Keeping them equal means a reload
 * restores exactly as much as the client can actually scroll back through —
 * capturing more from tmux would just be discarded.
 */
export const SCROLLBACK_LINES = 5000

export interface TileSpec {
  /** Stable id: tmux:<session>/<window name>/<pane index>. */
  id: string
  title: string
  subtitle: string
  /** tmux pane id, e.g. "%137". The tile renders exactly this pane. */
  paneId: string
  /** tmux window id, e.g. "@101". */
  windowId: string
  session: string
  cwd: string
  command: string
  paneIndex: number
  /**
   * Panes sharing this pane's window. Greater than 1 means the pane's size is
   * coupled to its siblings — they tile inside one window, so growing this one
   * shrinks a neighbour, like dragging a split.
   */
  siblings: number
  cols: number
  rows: number
}

export interface TileBox {
  x: number
  y: number
  w: number
  h: number
  z: number
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** A camera bookmark in slot 1–9, recalled with ⌥digit (see client/views.ts). */
export interface SavedView extends Viewport {
  slot: number
  name?: string
}

export interface Layout {
  tiles: Record<string, TileBox>
  viewport: Viewport
  /** Tiles the user explicitly closed; kept so they are not re-added. */
  hidden: string[]
  /** Optional so a layout.json from before saved views still loads. */
  views?: SavedView[]
  /**
   * Group names and colors, by group id: `s:<session>` for a session's own
   * group, `g:<id>` for one the user made (see client/groups.ts).
   */
  groups?: Record<string, GroupDef>
  /**
   * Tiles moved out of their session's group: tile id → group id, or '' for
   * no group. A tile missing here is in its session's group.
   */
  groupOf?: Record<string, string>
}

export interface GroupDef {
  name?: string
  hue?: number
}

/**
 * The canvas side of a tmuxinator project, kept under a `canvas:` key in its
 * .yml (tmuxinator ignores keys it does not know). Tiles are keyed relative
 * to the project — `<window name>/<pane index>` — so the arrangement follows
 * the project to whatever session it is started as.
 */
export interface CanvasBlock {
  tiles: Record<string, { x: number; y: number; w: number; h: number }>
  hidden?: string[]
  groups?: Record<string, GroupDef>
  /** Same meaning as `Layout.groupOf`, keyed like `tiles`. */
  groupOf?: Record<string, string>
  /**
   * tmux's exact layout per window, for windows whose own `layout:` is a
   * named one (`even-horizontal`…) that records no sizes. Keeps the panes
   * the size their tiles were saved at without rewriting the user's line.
   */
  layouts?: Record<string, string>
}

/** One .yml, on its way to disk or to the browser. */
export interface ProjectFile {
  name: string
  text: string
}

export type ClientMessage =
  | { type: 'open'; id: string; cols: number; rows: number }
  | { type: 'close'; id: string }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'layout'; layout: Layout }
  | { type: 'discover' }
  /** Break this pane into its own window so its size stops being coupled. */
  | { type: 'decouple'; id: string }
  | { type: 'spawn'; cwd?: string; command?: string; name?: string }
  | { type: 'start-project'; name: string }
  | { type: 'kill'; id: string }
  /**
   * Write sessions out as tmuxinator projects: `sessions` maps each session to
   * the project it goes into (several sessions may share one). `disk` saves
   * them in the tmuxinator dir, `download` hands the files back instead.
   * `overwrite` names projects the user agreed to regenerate from scratch.
   */
  | {
      type: 'export-projects'
      sessions: Record<string, string>
      layout: Layout
      target: 'disk' | 'download'
      overwrite?: string[]
    }
  /** Install .yml files in the tmuxinator dir and start them. */
  | { type: 'import-projects'; files: ProjectFile[]; overwrite?: string[] }

export type ServerMessage =
  | { type: 'init'; tiles: TileSpec[]; layout: Layout; projects: string[]; warnings: string[] }
  | { type: 'tiles'; tiles: TileSpec[]; warnings: string[] }
  | { type: 'output'; id: string; data: string }
  /**
   * The size tmux actually gave the pane. The server is the source of truth:
   * a tile asks for a size and then snaps to whatever comes back, so a pane
   * that shares a window never shows a size it does not really have.
   */
  | { type: 'geometry'; id: string; cols: number; rows: number }
  | { type: 'exit'; id: string }
  /**
   * Names the session a `spawn` just created, so the client can tell its own
   * new terminal apart from anything else tmux reports in the same push — a
   * duplicate has a spot reserved for it next to its origin.
   */
  | { type: 'spawned'; session: string }
  | { type: 'error'; message: string }
  /**
   * A project is about to start (or was just saved over a running one): place
   * its tiles. Sent before the tile list that shows them, so each lands
   * straight where the file says.
   */
  | { type: 'canvas'; session: string; canvas: CanvasBlock }
  | { type: 'exported'; target: 'disk' | 'download'; files: ProjectFile[]; warnings: string[] }
  /**
   * Nothing was written: these projects already exist and would be replaced
   * wholesale. The client asks, then repeats the request with `overwrite`.
   */
  | { type: 'project-conflict'; request: 'export-projects' | 'import-projects'; names: string[] }
  | { type: 'imported'; names: string[] }
  | { type: 'projects'; projects: string[] }
