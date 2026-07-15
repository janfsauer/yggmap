# yggmap

A free, fully private, one-page mind-mapping web app. No accounts, no server, no
tracking — everything lives in your browser's local storage. Inspired by the
[Excalidraw](https://excalidraw.com/) philosophy: the canvas *is* the app, zero
onboarding, keyboard-first.

Named after **Yggdrasil**, the Norse world-tree whose branches connect the nine
realms — the way a map's branches connect your ideas.

## Using it

Open the page and start typing your central idea. The app teaches itself:
dashed **ghost nodes** show where <kbd>Tab</kbd> (child) and <kbd>Enter</kbd>
(sibling) would create a node, and fade as you learn. Press <kbd>?</kbd> for
the full shortcut list.

- **Create**: `Tab` child · `Enter` sibling
- **Edit**: just type · `⌫` delete · `C` cycle color · `⌘Z`/`⇧⌘Z` undo/redo
- **Navigate**: arrow keys · `.` collapse/expand
- **View**: drag or `Space` to pan · `+`/`−`/pinch to zoom · `0` fit map

Multiple maps are managed via **☰ my maps** (stored per-browser; use
export/import to move them between devices — there is no sync).

On touch devices the ghosts become tappable create buttons and a contextual
action bar carries the remaining actions (edit, color, collapse, delete).

## Development

No build system — plain HTML/CSS/JS, on purpose. Deploying means copying the
files to any static host. To develop, serve the directory (browsers block
`localStorage`-heavy apps on `file://`):

```sh
python3 -m http.server 8471
# → http://localhost:8471/index.html
```

**Debug mode**: press `⌘⇧D` (or `Ctrl+Shift+D`) in the app to toggle it. It
currently reveals the *📱 mobile preview* button (bottom-right) which forces
the touch UI on desktop. The flag persists in `localStorage`.

### Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell: viewport, top bar, drawers, panels, shell-only CSS |
| `app.js` | The engine: state, storage, auto-layout, rendering, input, undo |
| `sketch.js` | `MMSketch` — seeded hand-drawn SVG connectors (jittered beziers) |
| `styles.css` | The living design system — all `.mm-*` components and tokens |
| `book.html` | Component book: renders every piece of `styles.css` with notes |
| `mockups/` | Design-exploration history (early style, mobile, focus studies) |
| `assets/` | Brand: web-ready WebP logo + wordmark, apple-touch-icon; `src/` full-res PNG originals |

`styles.css` is shared by the app, the component book, and some mockups —
change a component there and every consumer updates. Keep `book.html` in sync
when adding components.

### Storage schema (localStorage)

| Key | Content |
| --- | --- |
| `mindmaps.index.v1` | `[{id, title, updated}]` map list |
| `mindmaps.current.v1` | id of the open map |
| `mindmaps.map.<id>` | one map document (JSON tree, format-versioned via its `v` field) |
| `mindmaps.ui.v2` | view transform, learn counters, create mode, debug flag |
| `mindmaps.doc.v1` | legacy single-map key, kept as a migration backup |

Maps are KB-sized JSON, so `localStorage` is fine; the storage functions in
`app.js` are isolated so a later IndexedDB swap (e.g. for attachments) stays
local to that section.

## License

[MIT](LICENSE) — free for everyone, forever. Copyright Piotr Korzuszek and
yggmap contributors.
