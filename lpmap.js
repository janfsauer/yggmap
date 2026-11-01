/* lp-story-map: cloud sync, passcode gate, details panel, search and Markdown
   export layered on top of yggmap (MIT, Piotr Korzuszek and yggmap contributors).
   Loads BEFORE app.js: fetches the shared map from the private API, writes it
   into yggmap's localStorage slot, then boots the stock engine. */
(function () {
  'use strict';
  const API = 'https://inkruuxsbbqdqakrjmdl.supabase.co/functions/v1/lpmap';
  const MAP_ID = 'lpmap-main';
  const K = { key: 'lpmap.key', rev: 'lpmap.rev', dirty: 'lpmap.dirty' };
  const MAPKEY = 'mindmaps.map.' + MAP_ID;
  const q = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let key = null, baseRev = +(localStorage.getItem(K.rev) || 0);
  let pushTimer = null, pushing = false, pushAgain = false;

  /* ---------- api ---------- */
  async function api(path, opts = {}) {
    const r = await fetch(API + path, { ...opts, cache: 'no-store', headers: { 'content-type': 'application/json', 'x-key': key, ...(opts.headers || {}) } });
    let body = null; try { body = await r.json(); } catch (_) {}
    return { status: r.status, body };
  }
  function setStatus(txt, cls) {
    const el = q('#lp-status'); if (!el) return;
    el.textContent = txt; el.className = 'lp-status ' + (cls || '');
  }

  /* ---------- gate ---------- */
  function readKey() {
    const m = location.hash.match(/(?:^#|&)k=([^&]+)/);
    if (m) {
      localStorage.setItem(K.key, decodeURIComponent(m[1]));
      history.replaceState(null, '', location.pathname + location.search); // keep the passcode out of the address bar
    }
    return localStorage.getItem(K.key);
  }
  function showGate(msg) {
    const g = q('#lp-gate'); g.classList.add('open');
    q('#lp-gate-msg').textContent = msg || '';
    const inp = q('#lp-gate-input'); inp.focus();
    q('#lp-gate-form').onsubmit = e => {
      e.preventDefault();
      const v = inp.value.trim(); if (!v) return;
      localStorage.setItem(K.key, v); key = v;
      q('#lp-gate-msg').textContent = 'checking…';
      boot();
    };
  }
  function writeLocal(docObj) {
    localStorage.setItem(MAPKEY, JSON.stringify(docObj));
    let idx = []; try { idx = JSON.parse(localStorage.getItem('mindmaps.index.v1')) || []; } catch (_) {}
    if (!idx.some(m => m.id === MAP_ID)) idx.unshift({ id: MAP_ID, title: docObj.root.text || 'LP Story Map', updated: Date.now() });
    localStorage.setItem('mindmaps.index.v1', JSON.stringify(idx));
    localStorage.setItem('mindmaps.current.v1', MAP_ID);
  }
  function startApp() {
    q('#lp-gate').classList.remove('open');
    localStorage.setItem('mindmaps.current.v1', MAP_ID);
    const s = document.createElement('script'); s.src = 'app.js?v=lp3';
    s.onload = afterApp; document.body.appendChild(s);
  }
  let booted = false;
  async function boot() {
    key = key || readKey();
    if (!key) return showGate();
    const haveLocal = !!localStorage.getItem(MAPKEY);
    let r;
    try { r = await api('?what=doc'); } catch (e) { r = { status: 0 }; }
    if (r.status === 401) { localStorage.removeItem(K.key); key = null; return showGate('wrong passcode — try again'); }
    if (r.status === 429) return showGate('too many wrong tries — wait 15 minutes');
    if (r.status === 200 && r.body && r.body.doc) {
      const dirty = localStorage.getItem(K.dirty) === '1';
      if (dirty && haveLocal && r.body.rev === baseRev) {
        // unsynced local edits made on top of the server's current version — keep them and push
        booted = true; startApp(); setTimeout(() => schedulePush(10), 500); return;
      }
      if (dirty && haveLocal && r.body.rev !== baseRev)
        localStorage.setItem('lpmap.backup.' + Date.now(), localStorage.getItem(MAPKEY));
      writeLocal(r.body.doc);
      baseRev = r.body.rev; localStorage.setItem(K.rev, baseRev); localStorage.setItem(K.dirty, '0');
      booted = true; startApp();
      setTimeout(() => setStatus('saved ✓', 'ok'), 50);
      return;
    }
    if (haveLocal) { booted = true; startApp(); setTimeout(() => setStatus('offline — edits kept on this device', 'warn'), 50); return; }
    showGate('could not reach the server — check your connection and try again');
  }

  /* ---------- push ---------- */
  window.lpAfterSave = () => {
    if (!booted) return;
    localStorage.setItem(K.dirty, '1');
    schedulePush(1200);
  };
  function schedulePush(ms) { clearTimeout(pushTimer); setStatus('saving…', ''); pushTimer = setTimeout(push, ms); }
  async function push() {
    if (pushing) { pushAgain = true; return; }
    const json = localStorage.getItem(MAPKEY); if (!json) return;
    pushing = true;
    try {
      let r = await api('', { method: 'POST', body: '{"op":"saveDoc","rev":' + baseRev + ',"doc":' + json + '}' });
      if (r.status === 409) {
        // another device saved since we loaded. Last writer wins; the other
        // version is kept in the server's version history (versions menu).
        r = await api('', { method: 'POST', body: '{"op":"saveDoc","force":true,"rev":' + baseRev + ',"doc":' + json + '}' });
        if (r.status === 200) window.toast?.('another device had saved too — yours is now current; theirs is in “versions”');
      }
      if (r.status === 200) {
        baseRev = r.body.rev; localStorage.setItem(K.rev, baseRev);
        if (localStorage.getItem(MAPKEY) === json) { localStorage.setItem(K.dirty, '0'); setStatus('saved ✓', 'ok'); }
      } else if (r.status === 401) { setStatus('passcode rejected — reload', 'err'); }
      else { setStatus('not saved yet — retrying', 'warn'); setTimeout(() => schedulePush(10), 8000); }
    } catch (e) { setStatus('offline — will retry', 'warn'); setTimeout(() => schedulePush(10), 8000); }
    pushing = false;
    if (pushAgain) { pushAgain = false; schedulePush(10); }
  }
  addEventListener('online', () => { if (localStorage.getItem(K.dirty) === '1') schedulePush(10); });

  /* ---------- pull (another device saved) ---------- */
  async function pull() {
    if (!booted || document.hidden || localStorage.getItem(K.dirty) === '1' || pushing) return;
    if (window.__mm && window.__mm().editingId) return;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.lp-ui')) return;
    try {
      const r = await api('?what=rev');
      if (r.status !== 200 || r.body.rev === baseRev) return;
      const d = await api('?what=doc');
      if (d.status !== 200 || localStorage.getItem(K.dirty) === '1') return;
      writeLocal(d.body.doc); baseRev = d.body.rev; localStorage.setItem(K.rev, baseRev);
      window.adoptRemoteDoc?.();
      setStatus('updated from another device ✓', 'ok');
    } catch (_) {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  addEventListener('focus', pull);
  setInterval(pull, 30000);
  window.addEventListener('beforeunload', e => { if (localStorage.getItem(K.dirty) === '1') { push(); } });

  /* ---------- node kinds ---------- */
  window.lpNodeClass = (n) => {
    let c = '';
    if (n.kind) c += ' k-' + n.kind;
    if (n.src) c += ' src-' + n.src;
    if (n.gap) c += ' is-gap';
    return c;
  };
  window.lpNodePrefix = (n) => n.kind === 'story' ? '<span class="lp-dot"></span>' : n.gap ? '<span class="lp-gap">gap</span>' : '';
  window.lpInitNode = (node, parent) => {
    // parent is the new node's parent for createChild, the sibling's parent for createSibling
    const k = parent.kind;
    node.kind = k === 'root' ? 'lp' : k === 'lp' ? 'q' : 'story';
    if (node.kind === 'story') node.src = 'mine';
    node.body = '';
  };

  /* ---------- details panel ---------- */
  let shownId = null, bodySnap = null, bodyTimer = null;
  const KIND = { lp: 'Leadership Principle', q: 'Interview question', story: 'STAR story', pool: 'Suggested stories', root: 'Map' };
  const SRC = { bank: 'STAR bank (Oct 30)', script: 'Story script', onedoc: 'One-doc STAR', mine: 'Added by you' };
  function cur() { const m = window.__mm && window.__mm(); return m && nodeMapGet(m.focusId); }
  function nodeMapGet(id) { try { return nodeMap.get(id); } catch (_) { return null; } }
  function pathOf(n) { const out = []; let p = parentMap.get(n.id); while (p && p.kind !== 'root') { out.unshift(p.text); p = parentMap.get(p.id); } return out; }
  function lpUi() {
    const panel = q('#lp-panel');
    const n = cur();
    if (!n || n.kind === 'root' || !n.kind) { panel.classList.remove('show'); shownId = null; return; }
    panel.classList.add('show');
    if (shownId === n.id && document.activeElement === q('#lp-body')) return;
    if (shownId !== n.id) flushBody();
    shownId = n.id;
    q('#lp-kind').textContent = (KIND[n.kind] || '') + (n.src ? ' · ' + (SRC[n.src] || n.src) : '') + (n.gap ? ' · gap to fill' : '');
    q('#lp-path').textContent = pathOf(n).map(t => t.length > 60 ? t.slice(0, 57) + '…' : t).join(' › ');
    q('#lp-title').textContent = n.text || '(untitled)';
    const ta = q('#lp-body');
    if (ta.value !== (n.body || '')) ta.value = n.body || '';
    ta.placeholder = n.kind === 'story' ? 'Situation / Task / Action / Result — mark unknown numbers [confirm]' : 'notes';
    q('#lp-addstory').style.display = (n.kind === 'q' || n.kind === 'pool' || n.kind === 'lp' || n.kind === 'story') ? '' : 'none';
    q('#lp-dup').style.display = n.kind === 'story' ? '' : 'none';
    q('#lp-orig').style.display = n.sid ? '' : 'none';
    const cnt = n.kind === 'q' || n.kind === 'pool' ? n.children.filter(c => c.kind === 'story').length : null;
    q('#lp-count').textContent = cnt === null ? '' : cnt + ' stor' + (cnt === 1 ? 'y' : 'ies') + ' here';
  }
  window.lpAfterRefresh = lpUi;
  window.lpReserve = () => {
    const el = q('#lp-panel'); if (!el || !el.classList.contains('show')) return {};
    const r = el.getBoundingClientRect();
    return document.body.classList.contains('mobile') ? { b: innerHeight - r.top + 16 } : { r: innerWidth - r.left + 16 };
  };
  function flushBody() {
    clearTimeout(bodyTimer);
    if (bodySnap === null) return;
    const n = nodeMapGet(shownId);
    const v = q('#lp-body').value;
    if (n && (n.body || '') !== v) { pushUndo(bodySnap); n.body = v; saveDoc(); }
    bodySnap = null;
  }
  function wirePanel() {
    const ta = q('#lp-body');
    ta.addEventListener('focus', () => { bodySnap = snapshot(); });
    ta.addEventListener('input', () => {
      clearTimeout(bodyTimer);
      bodyTimer = setTimeout(() => {
        const n = nodeMapGet(shownId); if (!n) return;
        if (bodySnap !== null && (n.body || '') !== ta.value) {
          if (undoStack[undoStack.length - 1] !== bodySnap) pushUndo(bodySnap);
          n.body = ta.value; saveDoc();
        }
      }, 500);
    });
    ta.addEventListener('blur', () => { flushBody(); });
    q('#lp-rename').onclick = () => { const n = cur(); if (n) startEdit(n); };
    q('#lp-addstory').onclick = () => {
      const n = cur(); if (!n) return;
      if (n.kind === 'story') createSibling(n);
      else if (n.kind === 'lp') { const pool = n.children.find(c => c.kind === 'pool'); createChild(pool || n); }
      else createChild(n);
    };
    q('#lp-move').onclick = () => { const n = cur(); if (n) { startGrab(n); toast('now tap/click the question or LP to drop it on (Esc cancels)'); } };
    q('#lp-dup').onclick = () => {
      const n = cur(); if (!n) return;
      pushUndo();
      const c = JSON.parse(JSON.stringify(n)); c.id = 'n' + (doc.seq++) + 'd' + Math.random().toString(36).slice(2, 5); c.children = [];
      const p = parentMap.get(n.id); p.children.splice(p.children.indexOf(n) + 1, 0, c);
      markDirty(); refresh(); setFocus(c.id); toast('copy made — move it to another question');
    };
    q('#lp-del').onclick = () => { const n = cur(); if (n) deleteNode(n); };
    q('#lp-orig').onclick = async () => {
      const n = cur(); if (!n || !n.sid) return;
      const r = await api('?what=original&id=' + encodeURIComponent(n.sid));
      showText('Original text as imported (' + (r.body && r.body.source || '') + ')', r.body && r.body.original || 'not found');
    };
    q('#lp-collapse').onclick = () => document.body.classList.toggle('lp-min');
    // search
    const si = q('#lp-search'), res = q('#lp-results');
    si.addEventListener('input', () => {
      const t = si.value.trim().toLowerCase();
      if (t.length < 2) { res.innerHTML = ''; res.classList.remove('open'); return; }
      const hits = [];
      (function walk(n) { if (n.kind !== 'root' && ((n.text || '').toLowerCase().includes(t) || (n.body || '').toLowerCase().includes(t))) hits.push(n); n.children.forEach(walk); })(doc.root);
      res.innerHTML = hits.slice(0, 40).map(n => `<button data-id="${esc(n.id)}"><small>${esc(KIND[n.kind] || '')}</small>${esc((n.text || '').slice(0, 110))}</button>`).join('') || '<em>no matches</em>';
      res.classList.add('open');
    });
    res.addEventListener('click', e => {
      const b = e.target.closest('button[data-id]'); if (!b) return;
      reveal(b.dataset.id); res.classList.remove('open'); si.blur();
    });
    si.addEventListener('keydown', e => { if (e.key === 'Escape') { si.value = ''; res.classList.remove('open'); si.blur(); } if (e.key === 'Enter') res.querySelector('button')?.click(); });
    // menu
    q('#lp-menubtn').onclick = () => q('#lp-menu').classList.toggle('open');
    q('#lp-md').onclick = () => { q('#lp-menu').classList.remove('open'); download('lp-story-map.md', toMarkdown(), 'text/markdown'); };
    q('#lp-json').onclick = () => { q('#lp-menu').classList.remove('open'); download('lp-story-map.json', JSON.stringify(doc, null, 1), 'application/json'); };
    q('#lp-expand').onclick = () => { q('#lp-menu').classList.remove('open'); setAll(false); };
    q('#lp-fold').onclick = () => { q('#lp-menu').classList.remove('open'); setAll(true); };
    q('#lp-versions').onclick = versions;
    q('#lp-help').onclick = () => { q('#lp-menu').classList.remove('open'); q('#helpbtn').click(); };
    q('#lp-text-close').onclick = () => q('#lp-text').classList.remove('open');
  }
  function setAll(collapsed) {
    (function walk(n, d) { if (d >= 1 && n.children.length && n.kind !== 'q') n.collapsed = collapsed; if (n.kind === 'q' && n.children.length) n.collapsed = collapsed; n.children.forEach(c => walk(c, d + 1)); })(doc.root, 0);
    setFocus(doc.root.id); refresh(); fitMap();
  }
  function reveal(id) {
    let p = parentMap.get(id);
    while (p) { p.collapsed = false; p = parentMap.get(p.id); }
    refresh(); setFocus(id); ensureVisible(id);
  }
  function showText(title, text) {
    q('#lp-text-title').textContent = title; q('#lp-text-body').textContent = text;
    q('#lp-text').classList.add('open');
  }
  async function versions() {
    q('#lp-menu').classList.remove('open');
    const r = await api('?what=versions');
    if (r.status !== 200) return toast('could not load versions');
    const box = q('#lp-text-body');
    q('#lp-text-title').textContent = 'Saved versions (newest first) — tap one to restore it';
    box.innerHTML = r.body.map(v => `<button class="lp-ver" data-id="${v.id}">rev ${v.rev}${v.rev === 0 ? ' (original seed)' : ''} — ${new Date(v.saved_at).toLocaleString()}</button>`).join('');
    q('#lp-text').classList.add('open');
    box.onclick = async e => {
      const b = e.target.closest('.lp-ver'); if (!b) return;
      if (!confirm('Replace the current map with this version? (the current one stays in versions)')) return;
      const v = await api('?what=version&id=' + b.dataset.id);
      if (v.status !== 200 || !v.body.doc) return toast('could not load that version');
      writeLocal(v.body.doc); adoptRemoteDoc(); localStorage.setItem(K.dirty, '1'); schedulePush(10);
      q('#lp-text').classList.remove('open'); toast('version restored');
    };
  }
  function toMarkdown() {
    const L = ['# ' + (doc.root.text || 'LP Story Map'), ''];
    for (const lp of doc.root.children) {
      L.push('## ' + lp.text, ''); if (lp.body) L.push(lp.body, '');
      const story = (s, h) => { L.push(h + ' ' + s.text + (s.src ? ' _(' + (SRC[s.src] || s.src) + ')_' : ''), ''); if (s.body) L.push(s.body, ''); };
      for (const c of lp.children) {
        if (c.kind === 'pool') { if (c.children.length) { L.push('### Suggested stories', ''); c.children.forEach(s => story(s, '####')); } }
        else if (c.kind === 'q') {
          L.push('### Q: ' + c.text + (c.gap ? ' [gap]' : ''), ''); if (c.body) L.push(c.body, '');
          c.children.forEach(s => story(s, '####'));
        } else story(c, '###');
      }
    }
    return L.join('\n');
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function afterApp() {
    wirePanel(); lpUi();
    // the stock 'my maps' drawer would create local-only maps; this build is a single synced map
    document.title = 'LP Story Map';
  }
  window.lpDebug = () => ({ baseRev, dirty: localStorage.getItem(K.dirty), pushing });
  boot();
})();
