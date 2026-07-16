/* EMERGENCY ROLLBACK worker — never shipped by default (.assetsignore).
 *
 * If a broken sw.js ever reaches production, copy THIS FILE'S CONTENT over
 * sw.js (same URL — never delete sw.js, browsers don't unregister on 404)
 * and deploy. Every user recovers on their next navigation: this worker
 * installs over the broken one, wipes the caches, unregisters, and
 * force-reloads every open tab, which then loads straight from the network.
 * index.html's register() call re-registers it afterwards — harmless: the
 * fresh instance wipes nothing new, controls no tabs (no claim — see below),
 * finds no one to reload, and unregisters itself again; with no fetch
 * handler, requests pass through as if no worker existed.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // each step fault-isolated: recovery must reach the reload loop no matter
    // what fails on the way.
    // NEVER add clients.claim() here: the recovered page re-registers this
    // worker as a FRESH registration, and claiming that page would feed it
    // into matchAll() below → navigate() → reload → re-register → an infinite
    // reload storm (measured: ~140 reloads/second while deployed). The
    // genuine rollback pass needs no claim — a worker activating inside an
    // EXISTING registration inherits the broken worker's tabs automatically.
    try { for (const key of await caches.keys()) await caches.delete(key); } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    const clients = await self.clients.matchAll({ type: 'window' }).catch(() => []);
    await Promise.allSettled(clients.map((c) => c.navigate(c.url)));
  })());
});
