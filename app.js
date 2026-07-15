/* ============================================================
   mindmaps — interactive prototype
   DOM nodes + SVG connectors, auto-layout, keyboard-first on
   desktop, touch UI on mobile (two switchable create variants).
   ============================================================ */
'use strict';

const $ = s => document.querySelector(s);
const viewportEl = $('#viewport'), worldEl = $('#world'),
      linksEl = $('#links'), nodesEl = $('#nodes');

const DOC_VERSION = 1; // bump on breaking doc-shape changes; migrate lazily on load
const UI_KEY = 'mindmaps.ui.v2';
const INDEX_KEY = 'mindmaps.index.v1', CURRENT_KEY = 'mindmaps.current.v1';
const LEGACY_DOC_KEY = 'mindmaps.doc.v1';
const mapKey = id => 'mindmaps.map.' + id;
const H_GAP = 70, V_GAP = 16;
const COLOR_CYCLE = ['blue', 'pink', 'green', 'yellow'];
const GHOST_CHILD = 'ghost:child', GHOST_SIB = 'ghost:sibling';

/* ---------------- state ---------------- */

let mapIndex, currentMapId;
let doc = initStorage();
let ui = Object.assign(
  { learn: { tab: 0, enter: 0 }, forceMobile: false, debug: false, view: null },
  loadJSON(UI_KEY) || {});
delete ui.createMode; // retired A/B experiment (ghosts won over the bar)

let focusId = doc.root.id;
let editingId = null;
let editingWasNew = false;
let editingSnapshot = null;

let nodeMap = new Map(), parentMap = new Map(), depthMap = new Map();
let nodeEls = new Map();          // id -> element (includes ghost ids)
let lastPos = new Map();          // id -> {x, y, w, h} world coords (centers)
let lastLinks = [];               // {a, b, ghost} ids
let undoStack = [], redoStack = [];

let view = ui.view || { x: innerWidth / 2, y: innerHeight / 2, s: 1 };

function loadJSON(k) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
  catch { return null; }
}

function freshDoc() { return { v: DOC_VERSION, seq: 1, root: { id: 'n0', text: '', children: [] } }; }

/* untouched map: the first-visit look (placeholder, hint, no ghosts)
   must hold until the central idea gets real text — even after a stray
   click blurs the editor */
function isPristine() { return !doc.root.text && !doc.root.children.length; }

/* every doc passes through here on load — pre-version docs get stamped;
   a future format bump hooks its migration ladder in right here */
function hydrateDoc(d) {
  if (!d.v) d.v = DOC_VERSION;
  return d;
}

/* top-level branches keep a persistent side so inserting nodes
   never reshuffles the map; new branches go to the lighter side */
function migrateSides() {
  doc.root.children.forEach((c, i) => { if (!c.side) c.side = i % 2 === 0 ? 'R' : 'L'; });
}

function lighterSide() {
  let r = 0, l = 0;
  for (const c of doc.root.children)
    (c.side === 'L' ? (l += 1 + countDescendants(c)) : (r += 1 + countDescendants(c)));
  return r <= l ? 'R' : 'L';
}

function topSide(node) {
  let cur = node, p = parentMap.get(cur.id);
  while (p && p.id !== doc.root.id) { cur = p; p = parentMap.get(cur.id); }
  return p ? cur.side : null; // null for root itself
}

/* ---------- multi-map storage (localStorage; isolated here so a
   future swap to IndexedDB touches only these functions) ---------- */

function initStorage() {
  mapIndex = loadJSON(INDEX_KEY) || [];
  if (!mapIndex.length) {
    // migration of the single-map era, or a true first visit —
    // then start with an empty map, no questions asked
    const legacy = loadJSON(LEGACY_DOC_KEY);
    const first = legacy || freshDoc();
    const id = genMapId();
    localStorage.setItem(mapKey(id), JSON.stringify(first));
    mapIndex = [{ id, title: titleOf(first), updated: Date.now() }];
    saveIndex();
    localStorage.setItem(CURRENT_KEY, id);
  }
  currentMapId = localStorage.getItem(CURRENT_KEY);
  if (!mapIndex.some(m => m.id === currentMapId)) currentMapId = mapIndex[0].id;
  return hydrateDoc(loadJSON(mapKey(currentMapId)) || freshDoc());
}

function titleOf(d) { return (d.root.text || '').trim() || 'untitled'; }
function genMapId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function saveIndex() { localStorage.setItem(INDEX_KEY, JSON.stringify(mapIndex)); }

function saveDoc() {
  const entry = mapIndex.find(m => m.id === currentMapId);
  if (!entry) return; // current map was just deleted; don't resurrect it
  localStorage.setItem(mapKey(currentMapId), JSON.stringify(doc));
  entry.title = titleOf(doc);
  entry.updated = Date.now();
  saveIndex();
}

function switchMap(id) {
  if (id === currentMapId) return;
  if (editingId) commitEdit(false);
  saveDoc();
  currentMapId = id;
  localStorage.setItem(CURRENT_KEY, id);
  doc = hydrateDoc(loadJSON(mapKey(id)) || freshDoc());
  migrateSides();
  undoStack = []; redoStack = [];
  markDirty(); reindexIfNeeded();
  focusId = doc.root.id; editingId = null;
  refresh();
  fitMap();
}

function newMap() {
  if (editingId) commitEdit(false);
  const id = genMapId();
  localStorage.setItem(mapKey(id), JSON.stringify(freshDoc()));
  mapIndex.unshift({ id, title: 'untitled', updated: Date.now() });
  saveIndex();
  switchMap(id);
  mapsDialog.toggle(false);
  startEdit(doc.root);
}

function deleteMap(id) {
  localStorage.removeItem(mapKey(id));
  mapIndex = mapIndex.filter(m => m.id !== id);
  saveIndex();
  if (id === currentMapId) {
    if (mapIndex.length) switchMap(mapIndex[0].id);
    else { newMap(); return; }
  }
  renderMaps();
}

function exportAll() {
  const payload = {
    app: 'mindmaps', version: DOC_VERSION, exported: new Date().toISOString(),
    maps: mapIndex.map(m => ({ title: m.title, updated: m.updated, doc: loadJSON(mapKey(m.id)) })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mindmaps-export.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importFile(file) {
  file.text().then(txt => {
    const data = JSON.parse(txt);
    // fail fast on files we don't understand instead of breaking at render
    if ((data.version || 0) > DOC_VERSION) {
      toast('this file was exported by a newer version of the app');
      return;
    }
    let n = 0;
    for (const m of (data.maps || [])) {
      if (!m.doc || !m.doc.root) continue;
      const id = genMapId();
      localStorage.setItem(mapKey(id), JSON.stringify(hydrateDoc(m.doc)));
      mapIndex.unshift({ id, title: m.title || titleOf(m.doc), updated: Date.now() });
      n++;
    }
    saveIndex();
    renderMaps();
    toast(n ? `imported ${n} map${n === 1 ? '' : 's'}` : 'no maps found in that file');
  }).catch(() => toast('could not read that file'));
}
function saveUI() { ui.view = view; localStorage.setItem(UI_KEY, JSON.stringify(ui)); }

function reindex() {
  nodeMap.clear(); parentMap.clear(); depthMap.clear();
  (function walk(node, parent, depth) {
    nodeMap.set(node.id, node);
    parentMap.set(node.id, parent);
    depthMap.set(node.id, depth);
    node.children.forEach(c => walk(c, node, depth + 1));
  })(doc.root, null, 0);
}

function isMobile() { return ui.forceMobile || matchMedia('(pointer: coarse)').matches; }

/* ---------------- undo ---------------- */

function snapshot() { return JSON.stringify(doc); }
function pushUndo(snap) { undoStack.push(snap ?? snapshot()); redoStack = []; if (undoStack.length > 100) undoStack.shift(); }
function restore(json) {
  doc = JSON.parse(json); migrateSides(); reindex();
  if (!nodeMap.has(focusId)) focusId = doc.root.id;
  if (editingId && !nodeMap.has(editingId)) editingId = null;
  refresh();
  ensureVisible(focusId);
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

/* ---------------- ghosts ---------------- */

function learnLevel(key) {
  // capped at 2: ghosts fade to a faint whisper but never vanish —
  // a silently disappearing hint is indistinguishable from a bug
  const c = ui.learn[key] || 0;
  return c >= 6 ? 2 : c >= 3 ? 1 : 0;
}

function ghostSpecs() {
  if (editingId || !focusId || isPristine()) return [];
  const focus = nodeMap.get(focusId);
  if (!focus) return [];
  const mobile = isMobile();
  const specs = [];
  const tabLvl = mobile ? 0 : learnLevel('tab');
  const entLvl = mobile ? 0 : learnLevel('enter');
  if (tabLvl < 3) specs.push({ id: GHOST_CHILD, kind: 'child', level: tabLvl });
  if (entLvl < 3 && focusId !== doc.root.id) specs.push({ id: GHOST_SIB, kind: 'sibling', level: entLvl });
  return specs;
}

/* ---------------- shadow tree (layout input) ---------------- */
/* Clone of the visible tree with ghost entries injected, so the
   layout genuinely makes room for what a key/tap would create. */

function buildShadow() {
  const ghosts = ghostSpecs();
  const byKind = Object.fromEntries(ghosts.map(g => [g.kind, g]));
  function clone(node) {
    const sh = { id: node.id, ref: node, ghost: false, side: node.side, children: [] };
    if (!node.collapsed) {
      for (const c of node.children) {
        sh.children.push(clone(c));
        if (byKind.sibling && c.id === focusId)
          sh.children.push({ id: GHOST_SIB, ghost: true, side: c.side, level: byKind.sibling.level, children: [] });
      }
    }
    if (byKind.child && node.id === focusId)
      sh.children.push({
        id: GHOST_CHILD, ghost: true, level: byKind.child.level, children: [],
        side: node.id === doc.root.id ? lighterSide() : undefined
      });
    return sh;
  }
  return clone(doc.root);
}

/* ---------------- rendering ---------------- */

function elFor(sh) {
  let el = nodeEls.get(sh.id);
  if (!el) {
    el = document.createElement('div');
    el.dataset.id = sh.id;
    nodesEl.appendChild(el);
    nodeEls.set(sh.id, el);
  }
  return el;
}

function ghostLabel(kind) {
  if (isMobile()) return kind === 'child' ? '＋ child' : '＋ sibling';
  const key = kind === 'child' ? 'Tab' : 'Enter';
  return `<kbd class="mm-kbd mm-kbd--accent">${key}</kbd> ${kind}`;
}

function renderShadow(shadow) {
  const seen = new Set();
  (function walk(sh) {
    seen.add(sh.id);
    const el = elFor(sh);
    if (sh.ghost) {
      el.className = 'mm-ghost is-placed' +
        (isMobile() ? ' mm-ghost--tap' : '') +
        (sh.level === 1 ? ' learn-1' : sh.level === 2 ? ' learn-2' : '');
      const kind = sh.id === GHOST_CHILD ? 'child' : 'sibling';
      const label = ghostLabel(kind);
      if (el.dataset.label !== label) { el.innerHTML = label; el.dataset.label = label; }
    } else {
      const node = sh.ref, depth = depthMap.get(sh.id);
      let cls = 'mm-node is-placed';
      if (depth === 0) cls += ' mm-node--root';
      else if (depth >= 2 && !node.children.length && !node.color) cls += ' mm-node--leaf';
      if (node.color) cls += ' b-' + node.color;
      if (sh.id === focusId && sh.id !== editingId) cls += ' is-focused';
      if (sh.id === editingId) cls += ' is-editing';
      el.className = cls;
      if (sh.id !== editingId) {
        const badge = node.collapsed && node.children.length
          ? `<span class="mm-badge">+${countDescendants(node)}</span>` : '';
        // an empty root stays truly :empty so the CSS placeholder shows
        const emptyRoot = depth === 0 && !node.text;
        if (emptyRoot) el.dataset.ph = 'your central idea';
        const html = (emptyRoot ? '' : escapeHTML(node.text || ' ')) + badge;
        // '∅' keeps "render nothing" distinct from the cleared cache key
        const key = html || '∅';
        if (el.dataset.label !== key) { el.innerHTML = html; el.dataset.label = key; }
      }
    }
    sh.children.forEach(walk);
  })(shadow);
  for (const [id, el] of [...nodeEls]) {
    if (!seen.has(id)) { el.remove(); nodeEls.delete(id); }
  }
}

function escapeHTML(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function countDescendants(node) {
  let n = 0;
  (function walk(x) { for (const c of x.children) { n++; walk(c); } })(node);
  return n;
}

/* ---------------- layout ---------------- */

function layoutShadow(shadow) {
  const size = new Map();
  (function measure(sh) {
    const el = nodeEls.get(sh.id);
    size.set(sh.id, { w: el.offsetWidth, h: el.offsetHeight });
    sh.children.forEach(measure);
  })(shadow);

  const subH = new Map();
  (function calcH(sh) {
    let sum = 0;
    sh.children.forEach(c => { calcH(c); sum += subH.get(c.id); });
    sum += Math.max(0, sh.children.length - 1) * V_GAP;
    subH.set(sh.id, Math.max(size.get(sh.id).h, sum));
    return subH.get(sh.id);
  })(shadow);

  const pos = new Map();
  function place(sh, cx, cy, side) {
    const s = size.get(sh.id);
    pos.set(sh.id, { x: cx, y: cy, w: s.w, h: s.h });
    if (!sh.children.length) return;
    // split only at root, by each branch's persistent side
    const groups = side === 0
      ? [sh.children.filter(c => c.side !== 'L'), sh.children.filter(c => c.side === 'L')]
      : [sh.children];
    const dirs = side === 0 ? [1, -1] : [side];
    groups.forEach((kids, gi) => {
      if (!kids.length) return;
      const dir = dirs[gi];
      const total = kids.reduce((a, k) => a + subH.get(k.id), 0) + (kids.length - 1) * V_GAP;
      let y = cy - total / 2;
      for (const k of kids) {
        const kh = subH.get(k.id), ks = size.get(k.id);
        const kcx = cx + dir * (s.w / 2 + H_GAP + ks.w / 2);
        place(k, kcx, y + kh / 2, dir);
        y += kh + V_GAP;
      }
    });
  }
  place(shadow, 0, 0, 0);
  return pos;
}

function applyPositions(pos) {
  for (const [id, p] of pos) {
    const el = nodeEls.get(id);
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
  }
  lastPos = pos;
}

function collectLinks(shadow) {
  const links = [];
  (function walk(sh) {
    for (const c of sh.children) {
      links.push({ a: sh.id, b: c.id, ghost: c.ghost });
      walk(c);
    }
  })(shadow);
  return links;
}

function drawLinks(getP) {
  linksEl.innerHTML = '';
  for (const l of lastLinks) {
    const a = getP(l.a), b = getP(l.b);
    if (!a || !b) continue;
    const dir = b.x >= a.x ? 1 : -1;
    MMSketch.connect(linksEl,
      a.x + dir * (a.w / 2 + 4), a.y,
      b.x - dir * (b.w / 2 + 4), b.y,
      { ghost: l.ghost, seed: hashIds(l.a, l.b) });
  }
}

function hashIds(a, b) {
  let h = 7;
  for (const ch of a + '|' + b) h = (h * 31 + ch.charCodeAt(0)) % 2147483647;
  return h + 1;
}

let animTimer = null;
function animateLinks() {
  cancelAnimationFrame(animTimer);
  const t0 = performance.now();
  const fromRects = id => {
    const el = nodeEls.get(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: ((r.left + r.right) / 2 - view.x) / view.s,
      y: ((r.top + r.bottom) / 2 - view.y) / view.s,
      w: r.width / view.s, h: r.height / view.s
    };
  };
  (function frame(t) {
    drawLinks(fromRects);
    if (t - t0 < 360) animTimer = requestAnimationFrame(frame);
    else drawLinks(id => lastPos.get(id));
  })(t0);
}

/* ---------------- main refresh ---------------- */

function refresh() {
  reindexIfNeeded();
  const shadow = buildShadow();
  renderShadow(shadow);
  const pos = layoutShadow(shadow);
  applyPositions(pos);
  lastLinks = collectLinks(shadow);
  if (document.body.classList.contains('anim')) animateLinks();
  else drawLinks(id => lastPos.get(id));
  renderChrome();
  saveDoc(); saveUI();
}

let indexDirty = true;
function reindexIfNeeded() { if (indexDirty) { reindex(); indexDirty = false; } }
function markDirty() { indexDirty = true; }

/* ---------------- chrome ---------------- */

function renderChrome() {
  const mobile = isMobile();
  document.body.classList.toggle('mobile', mobile);
  document.body.classList.toggle('desktop', !mobile);
  document.body.classList.toggle('firstvisit', isPristine());
  $('#firsthint').textContent = editingId ? 'press Enter when done' : 'just start typing';
  document.body.classList.toggle('can-toggle-mobile', ui.debug && !matchMedia('(pointer: coarse)').matches);
  $('#mobiletoggle').textContent = ui.forceMobile ? '⌨️ back to desktop' : '📱 mobile preview';
  $('#zoom-val').textContent = Math.round(view.s * 100) + '%';

  // desktop hint strip (contextual)
  const strip = $('#hintstrip');
  if (editingId) {
    strip.innerHTML = hint('Enter', 'done') + hint('Tab', 'done + child') + hint('Esc', 'cancel');
  } else {
    strip.innerHTML = hint('Tab', 'child') + hint('Enter', 'sibling') + hint('⌫', 'delete') +
      hint('C', 'color') + hint('?', 'all shortcuts');
  }

  // mobile action bar (contextual)
  const bar = $('#actionbar');
  bar.innerHTML = '';
  let actions = [];
  if (editingId) {
    actions = [
      ['✕', 'cancel', () => commitEdit(true)],
      ['＋', 'child', () => { const id = editingId; commitEdit(false); const n = nodeMap.get(id); if (n) createChild(n); }],
      ['✓', 'done', () => commitEdit(false), 'accent'],
    ];
  } else if (focusId) {
    const focus = nodeMap.get(focusId);
    actions.push(['✎', 'edit', () => startEdit(focus)]);
    actions.push([colorDots(), 'color', () => cycleColor(focus)]);
    if (focus && focus.children.length)
      actions.push([focus.collapsed ? '⌃' : '⌄', focus.collapsed ? 'expand' : 'collapse', () => toggleCollapse(focus)]);
    if (focusId !== doc.root.id)
      actions.push(['✕', 'delete', () => deleteNode(focus), 'danger']);
  }
  for (const [glyph, label, fn, kind] of actions) {
    const b = document.createElement('button');
    b.className = 'mm-action' + (kind ? ' mm-action--' + kind : '');
    b.innerHTML = `<span class="glyph">${glyph}</span><span class="label">${label}</span>`;
    b.style.width = '52px'; b.style.height = '48px';
    b.addEventListener('pointerdown', e => e.stopPropagation());
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    bar.appendChild(b);
  }
  bar.classList.toggle('has-actions', actions.length > 0);
}

function hint(k, label) { return `<span><kbd class="mm-kbd">${k}</kbd> ${label}</span>`; }
function colorDots() {
  return `<span style="display:inline-flex;gap:2px">` +
    ['var(--mm-yellow)', 'var(--mm-pink)', 'var(--mm-blue)'].map(c =>
      `<i style="width:8px;height:8px;border-radius:50%;display:inline-block;border:1.3px solid rgba(58,53,50,.55);background:${c}"></i>`).join('') +
    `</span>`;
}

/* ---------------- mutations ---------------- */

function newNode() { return { id: 'n' + (doc.seq++), text: '', children: [] }; }

function createChild(parent) {
  if (!parent) return;
  pushUndo();
  const node = newNode();
  if (parent.id === doc.root.id) {
    node.color = COLOR_CYCLE[parent.children.length % COLOR_CYCLE.length];
    node.side = lighterSide();
  }
  parent.collapsed = false;
  parent.children.push(node);
  markDirty(); focusId = node.id;
  refresh();
  startEdit(node, undefined, true);
}

function createSibling(node) {
  if (!node || node.id === doc.root.id) return;
  pushUndo();
  const parent = parentMap.get(node.id);
  const sib = newNode();
  if (parent.id === doc.root.id) { sib.color = node.color; sib.side = node.side; }
  parent.children.splice(parent.children.indexOf(node) + 1, 0, sib);
  markDirty(); focusId = sib.id;
  refresh();
  startEdit(sib, undefined, true);
}

function deleteNode(node) {
  if (!node || node.id === doc.root.id) return;
  pushUndo();
  const parent = parentMap.get(node.id);
  const n = 1 + countDescendants(node);
  parent.children.splice(parent.children.indexOf(node), 1);
  markDirty(); focusId = parent.id;
  refresh();
  toast(`deleted ${n === 1 ? 'node' : n + ' nodes'}`, 'undo', undo);
}

function cycleColor(node) {
  if (!node) return;
  pushUndo();
  const i = COLOR_CYCLE.indexOf(node.color);
  if (node.id === doc.root.id) {
    // the root's "no color" state is already yellow — skip the null step
    // so every press visibly changes something
    node.color = COLOR_CYCLE[(i + 1) % COLOR_CYCLE.length];
  } else {
    node.color = i === COLOR_CYCLE.length - 1 ? null : COLOR_CYCLE[i + 1];
  }
  refresh();
}

function toggleCollapse(node) {
  if (!node || !node.children.length) return;
  node.collapsed = !node.collapsed;
  if (node.collapsed) {
    // focus must not point into a hidden subtree
    let p = parentMap.get(focusId);
    let cur = nodeMap.get(focusId);
    while (p) { if (p === node) { focusId = node.id; break; } cur = p; p = parentMap.get(p.id); }
  }
  refresh();
  ensureVisible(focusId);
}

/* ---------------- editing ---------------- */

let editStartAt = 0;

function startEdit(node, replaceWith, isNew = false) {
  if (!node || editingId) return;
  editingId = node.id;
  editStartAt = performance.now();
  editingWasNew = isNew;
  editingSnapshot = isNew ? null : snapshot();
  focusId = node.id;
  refresh();
  const el = nodeEls.get(node.id);
  el.contentEditable = 'plaintext-only' in document.body ? 'plaintext-only' : 'true';
  el.dataset.ph = node.id === doc.root.id ? 'your central idea' : 'new idea';
  el.textContent = replaceWith !== undefined ? replaceWith : node.text;
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el); range.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  el.addEventListener('keydown', onEditKeydown);
  el.addEventListener('blur', onEditBlur);
  ensureVisible(node.id);
}

function onEditKeydown(e) {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); commitEdit(false); }
  else if (e.key === 'Escape') { e.preventDefault(); commitEdit(true); }
  else if (e.key === 'Tab') {
    e.preventDefault();
    const id = editingId;
    commitEdit(false);
    const node = nodeMap.get(id);
    if (node) createChild(node);
  }
}

function onEditBlur() {
  if (!editingId) return;
  // a blur this soon after opening can't be the user leaving the editor —
  // it's the tap that created the node still settling (mobile keyboards,
  // synthesized events). Refocus instead of committing the empty node away.
  if (performance.now() - editStartAt < 400) {
    const el = nodeEls.get(editingId);
    requestAnimationFrame(() => { if (editingId && el) el.focus(); });
    return;
  }
  commitEdit(false);
}

function commitEdit(cancel) {
  const id = editingId;
  if (!id) return;
  const node = nodeMap.get(id);
  const el = nodeEls.get(id);
  el.removeEventListener('keydown', onEditKeydown);
  el.removeEventListener('blur', onEditBlur);
  el.contentEditable = 'false';
  el.blur();
  const text = el.textContent.replace(/\s+/g, ' ').trim();
  editingId = null;
  el.dataset.label = ''; // force re-render of content

  if (cancel) {
    if (editingWasNew) { removeQuiet(node); }
    else if (editingSnapshot) { /* text untouched in doc — nothing to restore */ }
  } else if (!text) {
    if (editingWasNew) removeQuiet(node);
    // else: keep old text (empty rename ignored)
  } else if (text !== node.text) {
    if (!editingWasNew && editingSnapshot) pushUndo(editingSnapshot);
    node.text = text;
  }
  editingWasNew = false; editingSnapshot = null;
  refresh();
  ensureVisible(focusId); // ghosts reappear on commit — bring them on screen
}

function removeQuiet(node) {
  const parent = parentMap.get(node.id);
  if (!parent) return;
  parent.children.splice(parent.children.indexOf(node), 1);
  markDirty();
  focusId = parent.id;
  // the creation snapshot is on the undo stack; drop it to keep undo clean
  undoStack.pop();
}

/* ---- keep the focused/edited node on screen ---- */

let glideTimer = null;
function cancelGlide() { cancelAnimationFrame(glideTimer); }

function glideTo(vx, vy, dur = 220) {
  cancelGlide();
  const x0 = view.x, y0 = view.y, t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  (function step(t) {
    const k = Math.min(1, (t - t0) / dur);
    view.x = x0 + (vx - x0) * ease(k);
    view.y = y0 + (vy - y0) * ease(k);
    applyView();
    if (k < 1) glideTimer = requestAnimationFrame(step);
    else saveUI();
  })(t0);
}

/* pan the minimum distance that puts the node (plus breathing room)
   inside the visible area — clear of chrome and the mobile keyboard.
   The focused node's ghosts come along when they fit: on mobile they are
   the create buttons, so an off-screen ghost is an unusable feature. */
function ensureVisible(id) {
  const p = lastPos.get(id);
  if (!p) return;
  const screenRect = q => ({
    l: (q.x - q.w / 2 - 24) * view.s + view.x,
    r: (q.x + q.w / 2 + 24) * view.s + view.x,
    t: (q.y - q.h / 2 - 24) * view.s + view.y,
    b: (q.y + q.h / 2 + 24) * view.s + view.y,
  });
  const node = screenRect(p);
  let u = { ...node };
  if (id === focusId) {
    for (const gid of [GHOST_CHILD, GHOST_SIB]) {
      const g = lastPos.get(gid);
      if (!g) continue;
      const r = screenRect(g);
      u = { l: Math.min(u.l, r.l), r: Math.max(u.r, r.r),
            t: Math.min(u.t, r.t), b: Math.max(u.b, r.b) };
    }
  }
  const W = innerWidth;
  const H = window.visualViewport ? visualViewport.height : innerHeight;
  const mL = 40, mR = 40, mT = 80, mB = 130;
  // per axis: fit the node+ghost union; if it simply can't fit
  // (e.g. sibling ghost below a tall subtree), the node itself wins
  const fit = (lo, hi, nlo, nhi, mLo, mHi, span) => {
    if (hi - lo > span - mLo - mHi) { lo = nlo; hi = nhi; }
    if (lo < mLo) return mLo - lo;
    if (hi > span - mHi) return (span - mHi) - hi;
    return 0;
  };
  const dx = fit(u.l, u.r, node.l, node.r, mL, mR, W);
  const dy = fit(u.t, u.b, node.t, node.b, mT, mB, H);
  if (dx || dy) glideTo(view.x + dx, view.y + dy);
}

if (window.visualViewport)
  visualViewport.addEventListener('resize', () => setTimeout(() => { if (editingId) ensureVisible(editingId); }, 50));

/* ---------------- focus & navigation ---------------- */

function setFocus(id) {
  if (editingId && id !== editingId) commitEdit(false);
  focusId = id;
  refresh();
  ensureVisible(id);
}

function navigate(dx, dy) {
  const cur = lastPos.get(focusId);
  if (!cur) return;
  let best = null, bestScore = Infinity;
  for (const [id, p] of lastPos) {
    if (id === focusId || id.startsWith('ghost:')) continue;
    const vx = p.x - cur.x, vy = p.y - cur.y;
    const along = vx * dx + vy * dy;
    if (along <= 8) continue;
    const off = Math.abs(vx * dy) + Math.abs(vy * dx);
    const score = along + off * 2.2;
    if (score < bestScore) { bestScore = score; best = id; }
  }
  if (best) setFocus(best);
}

/* ---------------- debug mode ---------------- */

function toggleDebug() {
  ui.debug = !ui.debug;
  if (!ui.debug) ui.forceMobile = false; // don't strand the user in mobile preview
  toast(ui.debug ? 'debug mode on' : 'debug mode off');
  refresh();
}

/* ---------------- toast ---------------- */

function toast(msg, actionLabel, actionFn) {
  const box = document.createElement('div');
  box.className = 'mm-toast';
  box.innerHTML = escapeHTML(msg);
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = '⌘Z ' + actionLabel;
    b.addEventListener('click', () => { box.remove(); actionFn(); });
    box.appendChild(b);
  }
  $('#toasts').appendChild(box);
  setTimeout(() => box.remove(), 4500);
}

/* ---------------- view (pan / zoom) ---------------- */

function applyView() {
  worldEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  $('#zoom-val').textContent = Math.round(view.s * 100) + '%';
}

function zoomAt(cx, cy, factor) {
  const s2 = Math.min(2.5, Math.max(0.25, view.s * factor));
  view.x = cx - (cx - view.x) * (s2 / view.s);
  view.y = cy - (cy - view.y) * (s2 / view.s);
  view.s = s2;
  applyView(); saveUI();
}

function fitMap() {
  if (!lastPos.size) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of lastPos.values()) {
    x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2);
    y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2);
  }
  const pad = 90;
  const s = Math.min(1.4, Math.min(
    innerWidth / (x1 - x0 + pad * 2),
    innerHeight / (y1 - y0 + pad * 2)));
  view.s = s;
  view.x = innerWidth / 2 - (x0 + x1) / 2 * s;
  view.y = innerHeight / 2 - (y0 + y1) / 2 * s;
  applyView(); saveUI();
}

/* pointer gestures: drag = pan, two fingers = pinch, tap node = focus/edit */
const pointers = new Map();
let pinchStart = null, panStart = null, downInfo = null;

viewportEl.addEventListener('pointerdown', e => {
  cancelGlide(); // never fight a user gesture
  const onNode = e.target.closest('.mm-node, .mm-ghost');
  // suppress the browser's synthesized mouse/focus pass for this tap:
  // on iOS it fires AFTER pointerup and would blur the editor a ghost tap
  // just opened, committing (and deleting) the empty new node
  if (onNode && onNode.dataset.id !== editingId) e.preventDefault();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  downInfo = { x: e.clientX, y: e.clientY, target: onNode, moved: false };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s,
                   mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: view.x, vy: view.y };
    panStart = null;
  } else if (!onNode || spaceDown) {
    panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    viewportEl.setPointerCapture(e.pointerId);
  }
});

viewportEl.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (downInfo && Math.hypot(e.clientX - downInfo.x, e.clientY - downInfo.y) > 8)
    downInfo.moved = true;
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const s2 = Math.min(2.5, Math.max(0.25, pinchStart.s * d / pinchStart.d));
    view.s = s2;
    view.x = mx - (pinchStart.mx - pinchStart.vx) * (s2 / pinchStart.s);
    view.y = my - (pinchStart.my - pinchStart.vy) * (s2 / pinchStart.s);
    applyView();
  } else if (panStart && pointers.size === 1) {
    view.x = panStart.vx + (e.clientX - panStart.x);
    view.y = panStart.vy + (e.clientY - panStart.y);
    viewportEl.classList.add('panning');
    applyView();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
  if (pointers.size === 0) { panStart = null; viewportEl.classList.remove('panning'); saveUI(); }
}
viewportEl.addEventListener('pointerup', e => {
  const info = downInfo; downInfo = null;
  endPointer(e);
  if (!info || info.moved || spaceDown) return;
  const el = info.target;
  if (!el) return;
  const id = el.dataset.id;
  // ghost taps don't count toward keyboard learning — only real key presses do
  if (id === GHOST_CHILD) { createChild(nodeMap.get(focusId)); return; }
  if (id === GHOST_SIB) { createSibling(nodeMap.get(focusId)); return; }
  const node = nodeMap.get(id);
  if (!node) return;
  if (id === editingId) return;
  if (id === focusId) startEdit(node);
  else setFocus(id);
});
viewportEl.addEventListener('pointercancel', endPointer);

viewportEl.addEventListener('wheel', e => {
  e.preventDefault();
  cancelGlide();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
  else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}, { passive: false });

/* ---------------- keyboard ---------------- */

let spaceDown = false;

document.addEventListener('keydown', e => {
  if (editingId) return; // handled on the element
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    toggleDebug();
    return;
  }
  if (mod) return;

  const dlg = openDialog();
  if (dlg) {
    if (dlg.closeKeys.includes(e.key)) { e.preventDefault(); dlg.toggle(false); }
    return;
  }

  const focus = nodeMap.get(focusId);
  switch (e.key) {
    case 'Tab': e.preventDefault(); ui.learn.tab++; createChild(focus); return;
    case 'Enter': e.preventDefault(); ui.learn.enter++; createSibling(focus); return;
    case 'Backspace': case 'Delete': e.preventDefault(); deleteNode(focus); return;
    case 'ArrowLeft': e.preventDefault(); navigate(-1, 0); return;
    case 'ArrowRight': e.preventDefault(); navigate(1, 0); return;
    case 'ArrowUp': e.preventDefault(); navigate(0, -1); return;
    case 'ArrowDown': e.preventDefault(); navigate(0, 1); return;
    case 'F2': e.preventDefault(); startEdit(focus); return;
    case 'Escape': e.preventDefault(); return;
    case ' ': spaceDown = true; e.preventDefault(); return;
    case '?': e.preventDefault(); helpDialog.toggle(true); return;
    case '.': e.preventDefault(); toggleCollapse(focus); return;
    case '0': e.preventDefault(); fitMap(); return;
    case '+': case '=': e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1.2); return;
    case '-': e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2); return;
    case 'c': case 'C': e.preventDefault(); cycleColor(focus); return;
  }

  // any other printable character starts editing (replaces text)
  if (e.key.length === 1 && !e.altKey) {
    e.preventDefault();
    startEdit(focus, e.key);
  }
});
document.addEventListener('keyup', e => { if (e.key === ' ') spaceDown = false; });

/* ---------------- dialogs ---------------- */

/* every overlay is the same pattern — trigger button + backdrop,
   click-outside and close-keys handled once; a new dialog is one call.
   btnSel is optional for dialogs the app opens itself (e.g. share import) */
const dialogs = [];
function makeDialog(backdropSel, btnSel, { onOpen, onClose, closeKeys = ['Escape'] } = {}) {
  const backdrop = $(backdropSel);
  const dlg = {
    open: false,
    closeKeys,
    toggle(open) {
      dlg.open = open;
      backdrop.classList.toggle('open', open);
      if (open) onOpen?.(); else onClose?.();
    },
  };
  if (btnSel) $(btnSel).addEventListener('click', () => dlg.toggle(!dlg.open));
  backdrop.addEventListener('click', e => { if (e.target === backdrop) dlg.toggle(false); });
  dialogs.push(dlg);
  return dlg;
}
const openDialog = () => dialogs.find(d => d.open);

/* ---------------- maps drawer ---------------- */

const mapsDialog = makeDialog('#mapsbackdrop', '#mapsbtn', { onOpen: renderMaps });

function relDate(t) {
  const d = Date.now() - t;
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' min ago';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' h ago';
  return Math.floor(d / 86400e3) + ' d ago';
}

function renderMaps() {
  const list = $('#mapslist');
  list.innerHTML = '';
  for (const m of mapIndex) {
    const row = document.createElement('div');
    row.className = 'map-row' + (m.id === currentMapId ? ' current' : '');
    row.innerHTML = `<span class="mtitle">${escapeHTML(m.title)}</span><span class="mdate">${relDate(m.updated)}</span>`;
    const share = document.createElement('button');
    share.className = 'mshare';
    share.textContent = '🔗';
    share.title = 'copy share link';
    share.addEventListener('click', e => { e.stopPropagation(); copyShareLink(m.id); });
    row.appendChild(share);
    const del = document.createElement('button');
    del.className = 'mdel';
    del.textContent = '✕';
    del.title = 'delete map';
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (del.dataset.armed) { deleteMap(m.id); }
      else {
        del.dataset.armed = '1'; del.textContent = 'sure?';
        setTimeout(() => { del.dataset.armed = ''; del.textContent = '✕'; }, 2500);
      }
    });
    row.appendChild(del);
    row.addEventListener('click', () => { switchMap(m.id); mapsDialog.toggle(false); });
    list.appendChild(row);
  }
}

$('#newmapbtn').addEventListener('click', newMap);
$('#exportbtn').addEventListener('click', exportAll);
$('#importbtn').addEventListener('click', () => $('#importfile').click());
$('#importfile').addEventListener('change', e => {
  if (e.target.files[0]) importFile(e.target.files[0]);
  e.target.value = '';
});

/* ---------------- panel, buttons ---------------- */

const helpDialog = makeDialog('#backdrop', '#helpbtn', { closeKeys: ['Escape', '?'] });

/* changes dialog: entries are plain HTML in index.html; the newest
   entry's data-date drives the "unseen" dot on the trigger */
const latestChange = $('#changeslist [data-date]')?.dataset.date || '';
// brand-new visitors get a calm first screen (nothing is "news" yet);
// returning users without the field keep it unset so the dot shows
if (ui.changesSeen === undefined && !loadJSON(UI_KEY)) ui.changesSeen = latestChange;
makeDialog('#changesbackdrop', '#changesbtn', {
  onOpen() { ui.changesSeen = latestChange; saveUI(); updateChangesDot(); },
});
function updateChangesDot() {
  $('#changesbtn').classList.toggle('has-news', ui.changesSeen !== latestChange);
}
updateChangesDot();

/* ---------------- share links ---------------- */
/* a share URL carries the whole map in its fragment — gzip → base64url —
   so the map never touches a server (fragments aren't sent in requests);
   opening the link imports a copy into "my maps" */

function b64uEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) // chunked: spreading 100k args blows the stack
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  return Uint8Array.from(atob(str.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
const gzip = text =>
  new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip')))
    .arrayBuffer().then(b => new Uint8Array(b));
const gunzip = bytes =>
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();

async function copyShareLink(id) {
  if (id === currentMapId) { if (editingId) commitEdit(false); saveDoc(); }
  const d = loadJSON(mapKey(id));
  if (!d) return;
  const url = location.origin + location.pathname + '#share=' + b64uEncode(await gzip(JSON.stringify(d)));
  try {
    await navigator.clipboard.writeText(url);
    toast('link copied — it carries a full copy of this map');
  } catch {
    // clipboard API needs a secure context + permission; fall back to the old way
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? 'link copied — it carries a full copy of this map' : 'could not copy the link');
  }
}

let pendingShare = null; // doc waiting on the keep-both / replace decision
const shareDialog = makeDialog('#sharebackdrop', null, {
  // closed without choosing (Esc / click outside) = ignore the link
  onClose() { if (pendingShare) { pendingShare = null; toast('link ignored — your maps are untouched'); } },
});
$('#sharekeep').addEventListener('click', () => {
  const d = pendingShare; pendingShare = null;
  shareDialog.toggle(false);
  if (d) addSharedMap(d, true);
});
$('#sharereplace').addEventListener('click', () => {
  const d = pendingShare; pendingShare = null;
  shareDialog.toggle(false);
  if (d) replaceSharedMap(d);
});

function importSharedFromHash() {
  const m = location.hash.match(/^#share=([A-Za-z0-9_-]+)/);
  if (!m) return;
  // consume the hash either way — a reload must not re-run the import
  history.replaceState(null, '', location.pathname + location.search);
  // decode inside the chain: atob can throw synchronously on a mangled
  // hash, and that must land in the same catch as async failures
  Promise.resolve(m[1]).then(s => gunzip(b64uDecode(s))).then(txt => {
    const d = JSON.parse(txt);
    if (!d.root || !d.root.id) throw new Error('not a map');
    // fail fast on links from a future format instead of breaking at render
    if ((d.v || 0) > DOC_VERSION) { toast('this link was made by a newer version of the app'); return; }
    hydrateDoc(d);
    if (mapIndex.some(x => x.title === titleOf(d))) {
      pendingShare = d;
      $('#sharename').textContent = titleOf(d);
      shareDialog.toggle(true);
    } else {
      addSharedMap(d, false);
    }
  }).catch(() => toast('could not read that share link'));
}

function addSharedMap(d, rename) {
  if (rename) {
    // map name IS the central idea (title derives from root text),
    // so numbering the root text renames both at once
    const base = titleOf(d);
    let n = 2;
    while (mapIndex.some(m => m.title === `${base} ${n}`)) n++;
    d.root.text = `${base} ${n}`;
  }
  prunePristineOnly();
  const id = genMapId();
  localStorage.setItem(mapKey(id), JSON.stringify(d));
  mapIndex.unshift({ id, title: titleOf(d), updated: Date.now() });
  saveIndex();
  switchMap(id);
  toast(`“${titleOf(d)}” added to your maps`);
}

function replaceSharedMap(d) {
  const entry = mapIndex.find(m => m.title === titleOf(d));
  if (!entry) { addSharedMap(d, false); return; }
  localStorage.setItem(mapKey(entry.id), JSON.stringify(d));
  entry.updated = Date.now();
  saveIndex();
  if (entry.id === currentMapId) {
    // switchMap() no-ops on the current id — swap the live doc by hand
    if (editingId) commitEdit(false);
    doc = d;
    migrateSides();
    undoStack = []; redoStack = [];
    markDirty();
    focusId = doc.root.id; editingId = null;
    refresh();
    fitMap();
  } else {
    switchMap(entry.id);
  }
  toast(`“${titleOf(d)}” replaced with the shared copy`);
}

/* opening a share link on a fresh install shouldn't leave the stray
   untouched "untitled" map behind in the drawer */
function prunePristineOnly() {
  if (mapIndex.length !== 1) return;
  const only = loadJSON(mapKey(mapIndex[0].id));
  if (only && !only.root.text && !only.root.children.length) {
    localStorage.removeItem(mapKey(mapIndex[0].id));
    mapIndex = [];
    saveIndex();
  }
}

$('#zoom-in').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1.2));
$('#zoom-out').addEventListener('click', () => zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2));

$('#mobiletoggle').addEventListener('click', () => { ui.forceMobile = !ui.forceMobile; refresh(); });

/* ---------------- boot ---------------- */

window.__mm = () => ({ focusId, editingId, rootId: doc.root.id });

migrateSides();
reindex(); indexDirty = false;
applyView();
refresh();
if (!ui.view) fitMap();
if (isPristine()) startEdit(doc.root); // untouched map boots straight into the caret
document.fonts.ready.then(() => {
  refresh();
  if (!loadJSON(UI_KEY)) fitMap(); // first run: fit after real fonts settle
});
setTimeout(() => document.body.classList.add('anim'), 300);
addEventListener('resize', () => refresh());
importSharedFromHash();
// pasting a share link into an already-open tab is a same-document
// navigation — no reload, so the boot-time check above never sees it
addEventListener('hashchange', importSharedFromHash);
