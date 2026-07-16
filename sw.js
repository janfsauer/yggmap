/* yggmap service worker — offline support, nothing else.
 *
 * Strategy: NETWORK-FIRST with an atomically-refreshed cache snapshot as the
 * offline fallback. Deliberately not cache-first: the server already sends
 * max-age=0/must-revalidate on every asset, so online loads were always
 * revalidated — this worker preserves those freshness semantics exactly
 * (no version string to bump, no way to pin users to stale code, which
 * matters because stale app code + a newer doc format is a data hazard).
 *
 * Invariants (see CLAUDE.md):
 * - this file must NEVER 404, be renamed, or be added to .assetsignore once
 *   shipped — browsers do not unregister on 404; a missing sw.js freezes
 *   users on whatever worker they have. Rollback = deploy sw-killswitch.js's
 *   content at this same URL.
 * - SHELL must list every file the app needs to run; the snapshot only swaps
 *   in when ALL of them fetch OK, so a partial deploy can never produce a
 *   mixed-version offline copy.
 * - coherence holds within the snapshot, not across a single lie-fi load:
 *   fallback is per-request, so one page load right after a deploy can mix
 *   snapshot and network responses. Accepted residual — a reload self-heals,
 *   and the app's DOC_VERSION latch contains the data hazard.
 */

const SNAP_LIVE = 'snap-live';
const SNAP_TMP = 'snap-tmp'; // prefix — each refresh gets its own scratch cache
const NETWORK_TIMEOUT_MS = 3000; // lie-fi guard; a truly dead network fails in ms
const TMP_MAX_AGE_MS = 60 * 60 * 1000; // scratch caches older than this are orphans

const SHELL = [
  '/',
  '/styles.css',
  '/sketch.js',
  '/app.js',
  '/assets/mark.webp',
  '/assets/fonts/patrick-hand-latin.woff2',
  '/assets/fonts/patrick-hand-latin-ext.woff2',
  '/assets/fonts/patrick-hand-vietnamese.woff2',
  '/assets/fonts/caveat-latin.woff2',
  '/assets/fonts/caveat-latin-ext.woff2',
  '/assets/fonts/caveat-cyrillic.woff2',
  '/assets/fonts/caveat-cyrillic-ext.woff2',
];

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // safe here because the app makes zero runtime fetches — a mid-session
    // worker swap can't hand a live page mixed-version lazy assets
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SNAP_LIVE).map((n) => caches.delete(n)));
    await self.clients.claim();
    await refreshSnapshot(); // prime on first install: offline-capable from visit one
  })());
});

/* Fetch the whole shell, and only replace the live snapshot when every file
   arrived OK — an all-or-nothing swap, so the offline copy is always one
   coherent deploy. {cache:'reload'} bypasses the HTTP cache: a "success"
   must mean the server really answered. */
let refreshInFlight = null;
function refreshSnapshot() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const responses = await Promise.all(SHELL.map(async (url) => {
      const resp = await fetch(url, { cache: 'reload' });
      if (!resp.ok) throw new Error('snapshot refresh: ' + url + ' -> ' + resp.status);
      return resp;
    }));
    // best-effort sweep of scratch caches orphaned by a hard worker kill
    // mid-refresh — activate's sweep never fires again while sw.js stays
    // byte-stable (this worker's steady state). Age-gated so a genuinely
    // concurrent refresh from another worker instance is never swept mid-copy
    // (extendable events cap at ~5min; 1h is far beyond any live refresh).
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => {
        if (!n.startsWith(SNAP_TMP + '-')) return;
        const ts = Number((new RegExp('^' + SNAP_TMP + '-(\\d+)-').exec(n) || [])[1]);
        if (!Number.isFinite(ts) || Date.now() - ts > TMP_MAX_AGE_MS) return caches.delete(n);
      }));
    } catch (e) { /* the sweep must never fail the refresh */ }
    // unique scratch cache per refresh: during a worker update the outgoing
    // and incoming instances can refresh concurrently and must not interleave
    // on a shared name
    const tmpName = SNAP_TMP + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    try {
      const tmp = await caches.open(tmpName);
      await Promise.all(SHELL.map((url, i) => tmp.put(url, responses[i])));
      const live = await caches.open(SNAP_LIVE);
      try {
        await Promise.all(SHELL.map(async (url) => {
          const stored = await tmp.match(url);
          await live.put(url, stored);
        }));
      } catch (err) {
        // a half-written live snapshot mixes two deploys — worse than none.
        // offline-unavailable beats offline-incoherent; the next successful
        // online visit rebuilds it whole.
        await caches.delete(SNAP_LIVE);
        throw err;
      }
    } finally {
      await caches.delete(tmpName);
    }
  })().catch(() => { /* fetch-phase failure: the old coherent snapshot stays */ })
     .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/* Race the fetch against the timeout, but keep a handle on the original
   promise: a losing-but-still-pending fetch is deliberately NOT aborted —
   for requests the snapshot can't cover, slow-and-late beats a hard failure
   (and rebuilding the request for an AbortController would silently
   downgrade navigate-mode requests). */
function networkWithTimeout(req) {
  const network = fetch(req);
  network.catch(() => {}); // rejection is consumed by whichever branch uses it
  const timeout = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), NETWORK_TIMEOUT_MS);
    network.finally(() => clearTimeout(timer)).catch(() => {});
  });
  return { race: Promise.race([network, timeout]), network };
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(handleFetch(event, req));
});

async function handleFetch(event, req) {
  const { race, network } = networkWithTimeout(req);
  try {
    const resp = await race;
    if (resp.ok && req.mode === 'navigate') event.waitUntil(refreshSnapshot());
    return resp;
  } catch (err) {
    // navigations normalize to the shell entry: production 307-redirects
    // /index.html to /, and the snapshot is keyed on / alone
    const lookupKey = req.mode === 'navigate' ? '/' : req;
    const cached = await caches.match(lookupKey, { cacheName: SNAP_LIVE, ignoreSearch: true });
    if (cached) {
      // a snapshot-served navigation must still converge on the deployed
      // version — refresh in the background (untimed, so a slow-but-working
      // network gets there; a dead one fails instantly and keeps the snapshot)
      if (req.mode === 'navigate') event.waitUntil(refreshSnapshot());
      return cached;
    }
    // nothing cached (favicons, manifest, …): hand back the still-pending
    // fetch — pre-worker behavior, where slow used to mean late, not broken
    return network;
  }
}
