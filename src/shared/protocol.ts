/** Wire protocol shared by the control-mode server and the canvas client. */

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

export interface Layout {
  tiles: Record<string, TileBox>
  viewport: Viewport
  /** Tiles the user explicitly closed; kept so they are not re-added. */
  hidden: string[]
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
  | { type: 'spawn'; cwd?: string; command?: string }
  | { type: 'start-project'; name: string }
  | { type: 'kill'; id: string }

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
  | { type: 'error'; message: string }
