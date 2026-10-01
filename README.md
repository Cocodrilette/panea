# terminal-canvas

An infinite pan/zoom canvas where every tmux pane is a tile you can move,
resize and type into. Built for tmuxinator setups with many windows and panes,
where `Ctrl+b s` and hunting for the right pane becomes the bottleneck.

![terminal-canvas app screenshot](assets/image.png)

> The interface is currently in Spanish. Labels quoted below are shown as they
> appear in the app, with a translation.

## Requirements

- [tmux](https://github.com/tmux/tmux), with a server running
- Node.js 22.6 or newer (the server runs TypeScript directly with
  `--experimental-strip-types`)
- [tmuxinator](https://github.com/tmuxinator/tmuxinator), optional, for the
  project features
- macOS is the primary target (auto-opening the browser and the LaunchAgent are
  macOS-only); the server itself runs anywhere tmux does

There are no native dependencies, so `npm install` doesn't compile anything.

## Usage

```bash
npm install          # once
npm run canvas       # build + server, opens the browser
```

The server listens on `http://127.0.0.1:7788` (set `TCV_PORT` to change it).
It discovers whatever is already running in tmux and never starts anything on
its own, so it won't duplicate servers or fight over ports.

| Gesture | Action |
|---|---|
| drag the background, or two-finger scroll over the background | pan |
| scroll over a terminal | scroll its scrollback (the canvas stays put) |
| ⌘/ctrl + scroll, or trackpad pinch | zoom (centered on the cursor) |
| click a terminal | focus it and give it the keyboard |
| ⌘esc, or click the background | release focus |
| ⌘K, type, ↑↓ and enter | jump to a pane: fuzzy search by title, window, session, command and cwd; flies to the tile and focuses it |
| ⌘⌥ + arrows, or ctrl+⌥ + arrows | move focus to the nearest tile in that direction (from the center of the window if nothing is focused) |
| drag the title bar | move the tile (with smart guides: snaps to edges, centers and spacing of visible tiles) |
| double-click the title bar | centered zoom: the tile fills most of the screen |
| drag a group's name (its frame) | move all its tiles together (with guides: the frame snaps to other frames) |
| drag a tile into another frame / out of its own | move it to that group / take it out of the group |
| click a tile's group chip | move it to another group, a new one, or none |
| shift + click titles, or shift + drag the background | select tiles to group them |
| double-click a group's name, or its `⋯` | rename, recolor, dissolve |
| bottom-right corner | resize (sets the pane's real cols/rows); snaps to other tiles' sizes |
| hold ⌥ while moving or resizing | disable the guides: no snapping |
| ⌘0 / ⌘1 / ⌘G | fit all / zoom 100% / repack by group |
| ⌘T / ⌘R | new terminal / rescan tmux |
| ⌥⇧1…9 / ⌥1…9 | save the camera to that slot / go back to it (animated) |
| ⌘J, or `⚑` in the toolbar | jump to the next terminal that needs attention |
| drag or paste an image onto a terminal | type its path into the prompt |

Tile buttons: `⊕` duplicate (another terminal in the same directory, right
next to it), `⤢` zoom to that terminal, `⧉` break the pane out into its own
window to decouple its size, `✕` remove from the canvas (the process keeps
running), `⌫` kill the pane and its processes.

**Saved views** are camera bookmarks. The `⋯` menu lists them so you can jump
to one, rename it or delete it, and *+ Guardar vista* ("save view") asks for a
name and takes the first free slot. The shortcut isn't ⌘⇧digit because macOS
grabs ⌘⇧3/4/5 (screenshots) before the browser sees them, and ⌘/ctrl+digit
already belong to the canvas and to Chrome. ⌥digit works even while a terminal
has focus; the price is that terminals no longer receive Meta-1…9.

The layout (positions, camera, groups and saved views) is stored in
`~/.config/terminal-canvas/layout.json` and restored on open.

### Access and security

The canvas types into real shells, so the server only accepts requests that
come from the canvas itself:

- **Sign-in token.** On first run the server creates a random token in
  `~/.config/terminal-canvas/token` (mode `0600`). The browser it opens
  receives a one-time `?token=…` link, which sets an `HttpOnly`,
  `SameSite=Strict` cookie and redirects to the clean URL. A browser without
  the cookie gets a locked page. To sign in another browser, or after clearing
  cookies, run `npm run canvas` again: if a server is already running it just
  opens the sign-in link against it. The link is also printed when the server
  runs in a terminal (never into the launchd log).
- **Origin and Host checks.** Browsers let any website open a WebSocket to
  `127.0.0.1`, since CORS doesn't apply to WebSockets. The server rejects any
  handshake or upload whose `Origin` isn't the canvas, and any request whose
  `Host` isn't this server, which also defeats DNS rebinding.
- **Loopback by default.** `TCV_HOST` can bind another address, but traffic is
  unencrypted and anyone holding the token controls your terminals, so the
  server warns when it isn't on loopback. To reach it from elsewhere, prefer an
  SSH tunnel (`ssh -L 7788:127.0.0.1:7788 host`).

To revoke every signed-in browser, delete the token file and restart the server.

### tmuxinator projects

The *tmuxinator* section of the `⋯` menu saves the canvas as tmuxinator
projects, so a terminal setup can be versioned, moved to another machine, or
started from scratch:

- **Guardar…** ("save") writes each session to
  `~/.config/tmuxinator/<project>.yml`. If the project already exists, only its
  `canvas:` block is rewritten, so hand-written commands and comments are left
  alone. Otherwise the file is generated from tmux: windows, exact `layout`,
  directories, and each pane's command read from the process table. That
  recovers `python manage.py runserver`, not whatever ran before it on the same
  line (`av && …`), so review it. Several sessions with the same project name
  are merged into one (useful for terminals created from the canvas).
- **Exportar…** ("export") does the same but downloads the `.yml` files.
- **Importar…** ("import") installs `.yml` files into the tmuxinator directory
  and starts them.
- **Arrancar…** ("start") launches an installed project. In all three cases
  the tiles land where the `canvas:` block says; if the session was already
  running, they only move.

The `canvas:` block (tmuxinator ignores keys it doesn't know) stores each
pane's position and size as `<window>/<pane>`, its groups' names and colors,
and, for windows with a named layout (`even-horizontal`…), tmux's exact layout,
so panes come back at their tile's size.

### Images

Dragging an image onto a terminal, or pasting it with ⌘V from the clipboard,
types its **absolute path** into the prompt. That's exactly what a native
terminal produces when you drop a file on it, so Claude Code, an editor or
`open` just read it. No Enter is sent: the path stays in the prompt so you can
keep writing around it.

A browser only hands over bytes, never a usable local path, so the image is
uploaded to the server and lands in `~/.config/terminal-canvas/images/`.
These are scratch files and are deleted after 7 days. Supported formats: PNG,
JPEG, GIF, WebP, AVIF, BMP, TIFF, HEIC and SVG, up to 25 MB.

## As an installed app

The canvas installs as a PWA: its own window, a Dock icon, its own ⌘Tab entry,
and no address bar. It's the same Chrome and the same renderer as the tab, so
it costs nothing in performance.

```bash
npm run autostart    # LaunchAgent: keeps the server alive and starts it at login
```

Then run `npm run canvas` once (it signs Chrome in against the running agent)
and install the app from the icon in the address bar (or ⋮ → *Cast, save and
share* → *Install page as app*). `npm run autostart:off` uninstalls it and
`npm run autostart:status` shows what launchd thinks; logs go to
`~/Library/Logs/terminal-canvas.log`.

The agent freezes the path of the current node: if you switch versions with
nvm, run `npm run autostart` again. Since it holds the port, `npm run canvas`
no longer fails: it sees a running server and opens the browser against it.
The reverse works too: the agent waits for you to release the port and takes it
back within seconds.

In a normal tab Chrome reserves ⌘⌥←/→ for switching tabs, so there, tile
navigation uses ctrl+⌥ + arrows, which works in any window.

Two things the PWA window doesn't give you. Chrome keeps ⌘W (close) and its
reload menu, so if a shortcut doesn't reach the app, the `⋯` menu has the same
commands. And the service worker caches only the shell (network-first, so
`npm run dev` doesn't serve yesterday's `main.js`): if the server is down, the
window still opens, just without tiles.

Icons are regenerated with `npm run icons`, which draws an SVG with
Playwright's Chromium and writes `assets/icons/*.png` (these are committed).

## How it works

- **One tile = one pane, via control mode.** The server opens one
  `tmux -C attach` client per *session* (not per tile), and that client
  receives the `%output` of every pane in the session, including panes in
  inactive windows. A tile is just a route: pane id → browser.
- **The canvas owns nothing in tmux.** It creates no sessions. Its control
  clients are just clients, so they don't show up in your session list and
  don't keep any window alive. If you destroy a session (`tmuxinator stop`,
  `kill-session`), its client exits and the tiles die with it, exactly as tmux
  would behave without the canvas. This is a rule, not a detail: an earlier
  version used a *grouped session* per tile, and those references kept
  processes of an already-destroyed session alive, still holding their ports.
- **tmux decides the size, and the canvas tells the truth.** The canvas sets
  `window-size manual` on the windows it shows and sizes them itself. A pane
  alone in its window gets exactly the size you ask for. Panes that share a
  window split one rectangle, so there the tile asks, the server applies what
  tmux allows, and replies with the **real** geometry. The tile adapts to that
  reply instead of showing a size it doesn't have. The *tamaño acoplado*
  ("coupled size") badge marks those panes, and `⧉` is the way out: it moves
  the pane to its own window.
- **Opening doesn't reshuffle; dragging does.** When opening, a tile can only
  *grow* its window. Otherwise three tiles from the same window would take
  turns claiming the full height and squeeze each other down to one row. An
  explicit drag does move the split, as in tmux, and if it leaves a sibling
  under three rows the server rescues it to the minimum.
- **Processes don't live in the canvas.** They live in tmux. You can close the
  browser or kill the server and everything keeps running. When you come back,
  tiles reconnect and repaint with `capture-pane`.
- **Scrolling has one owner at a time.** A scroll over a terminal is for its
  scrollback, not for the camera. xterm marks the event as consumed
  (`preventDefault`) but lets it bubble, so the canvas used to pan too and the
  text you were reading slid away; now the canvas respects that mark. The
  gesture also stays latched to that terminal for 250 ms, so hitting the end of
  the scrollback mid-inertia doesn't hand the rest of the motion to the canvas.
- **Sharp zoom.** It uses xterm's DOM renderer, not WebGL: text is real text and
  the browser re-rasterizes it when scaling, so it stays sharp at any zoom
  level (and doesn't spend a WebGL context per tile).
- **Groups, seeded by session.** Behind each group's tiles is a frame with its
  name and its own tint. Initially there's one group per tmux session, but the
  groups are yours: dropping a tile inside another frame moves it to that
  group, dragging it far from the rest of its group leaves it on its own, and
  shift selects several to make a new group. Only deviations are stored
  (`groupOf` and `groups` in the layout), so a pane that appears later falls
  into its session's group. The frame has no position of its own: it's always
  the box around its tiles plus a margin. Dragging it moves the tiles, and the
  tiles are what get saved. It learns about changes by observing each tile's
  `style` (every movement ends up there) instead of every caller having to
  notify it. When zoomed out, the label grows in world coordinates to keep its
  on-screen size, and below the detail threshold it rises above the tiles,
  which is exactly when you navigate by group most. ⌘G packs each group
  separately and lays the groups side by side.
- **Level of detail.** Below 55% zoom, unfocused tiles stop rendering the live
  terminal and show a text snapshot, refreshed every 1.5 s. That's what keeps
  zooming out smooth with a dozen terminals spewing logs.
- **Activity and attention.** An unfocused tile gets a colored border and a
  label in its bar (and a large one over the snapshot when zoomed out):
  *salida nueva* ("new output") while it's writing, *en silencio* ("quiet")
  once it stops, *campana* ("bell") if it rang a BEL, and *espera respuesta*
  ("waiting for input") if it went quiet on something that looks like a
  question: Claude Code's approval dialog, a `[y/N]`, a `Password:`. The
  heuristic is narrow on purpose, because a false alarm teaches you to ignore
  it. Everything happens in the client, reading xterm's buffer; neither the
  server nor tmux know about it. The repaint on open, on resize or on releasing
  focus doesn't count as new output. Focusing a tile clears its marks, and ⌘J
  (or `⚑`) jumps to the most urgent one.

## Layout

```
src/server/index.ts    HTTP + WebSocket server, pane → browser routes
src/server/auth.ts     who may connect: token, cookie, Origin and Host checks
src/server/control.ts  tmux control-mode client (line protocol)
src/server/tmux.ts     discovery, sizing and lifecycle
src/server/store.ts    persisted layout
src/server/tmuxinator.ts tmuxinator projects: list, start, save, import
src/server/uploads.ts  dropped/pasted images, saved to disk
src/client/viewport.ts pan/zoom camera (a single CSS transform)
src/client/camera.ts   animated camera flights (fit, reveal a tile)
src/client/fuzzy.ts    fuzzy search and highlighting for the ⌘K picker
src/client/spatial.ts  the neighboring tile in a direction (⌘⌥ + arrows)
src/client/tile.ts     tile: xterm, drag, resize, snapshot, image drops
src/client/guides.ts   smart guides: snapping to edges, centers, spacing and size
src/client/groups.ts   groups: frames, editor (drag, chip, selection) and ⌘G
src/client/activity.ts new output, bell and "waiting for input" per tile
src/client/images.ts   image upload and the path that gets typed
src/client/views.ts    saved views: camera bookmarks, shortcuts and menu
src/client/projects.ts save / export / import tmuxinator projects
src/client/metrics.ts  cell size measurement
src/client/sw.js       PWA service worker (cached shell, network-first)
src/client/manifest.webmanifest
                       PWA manifest
src/shared/protocol.ts WebSocket protocol
```

## Tests

```bash
npm run canvas                      # in one terminal
PORT=7788 node scripts/ctl-e2e.mjs  # transport, sizing and lifecycle
SP=/tmp PORT=7788 node scripts/ui-check.mjs   # headless browser, screenshots in $SP
```

Both scripts sign in with the token from `~/.config/terminal-canvas/token`.
`ctl-e2e.mjs` creates a throwaway session and checks, among other things, that
killing the base session takes its tiles and processes with it, that no extra
session is created, and that a huge drag doesn't leave a sibling pane at one
row. Run it against a server on its own port, with no other canvas open:
another canvas attaches its own control client to the test session and trips
the one-client-per-session check.

## Implementation notes

- Control mode's `%output` escapes control bytes as `\ooo` octal and passes raw
  UTF-8 through, so unescaping works on bytes: decoding first would break a
  multibyte character split across two messages.
- Cell size is measured from the DOM (`.xterm-screen` ÷ cols/rows), not from
  `dimensions.css.cell`, because xterm's published build mangles its private
  properties. It's also measured with the world transform neutralized, or the
  zoom factor leaks into the measurement.
- The server runs TypeScript directly with `--experimental-strip-types`, which
  doesn't support constructor *parameter properties*, so `control.ts` assigns
  its fields by hand.
- tmux replaces the field separator (`\x1f`) in its `-F` formats with `_` when
  the environment has no UTF-8 locale. Under launchd that turned discovery into
  garbage and left the canvas empty, so the LaunchAgent exports `LANG`, and
  discovery drops lines that don't carry every field, warning instead of
  inventing tiles.
- With `TCV_WAIT_PORT=1` (set by the LaunchAgent) the server waits for the port
  to free up instead of dying: under launchd, dying only causes a restart loop.
  In the foreground it does the opposite: it reports that a server is already
  running and opens the browser against it.
- `client_control_mode` tells the canvas's clients apart from your terminals,
  so it doesn't warn you about a size conflict with itself.

## License

[MIT](LICENSE)
