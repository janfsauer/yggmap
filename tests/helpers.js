// @ts-check
/* Shared plumbing for driving the real app in a real browser.
   Each Playwright test gets a fresh browser context, so localStorage
   starts empty — fixtures are injected before any page script runs. */

/* The standard fixture: mirrors the map that exposed the navigation bug —
   a root with one branch per side, two children under each. */
const BRANCHES = [
  ['Star Citizen', [['SC Pass'], ['All major SC products']], { side: 'R' }],
  ['Elite Dangerous', [['Elite Pass'], ['All major ED products']], { side: 'L' }],
];

/** Build a doc from a terse spec: ['text', [children]] pairs.
 *  Depth-1 nodes need an explicit side ('R'/'L') in their spec. */
let seq;
function toNode(spec) {
  const [text, children = [], extra = {}] = spec;
  return { id: 'n' + seq++, text, children: children.map(toNode), ...extra };
}
function buildDoc(rootText, branches) {
  seq = 1;
  return {
    v: 1,
    root: { id: 'n0', text: rootText, children: branches.map(toNode) },
    seq: 999, // keep app-generated ids clear of fixture ids
  };
}

/** Plant raw localStorage entries before any page script runs.
 *  Init scripts re-run on reload, so each key is seeded only while absent —
 *  the app's own saves win, letting tests assert persistence across reloads.
 *  (Corollary: a reload after deleting a seeded key re-plants it.) */
async function seedStorage(page, entries) {
  await page.addInitScript(kv => {
    for (const [k, v] of Object.entries(kv))
      if (localStorage.getItem(k) === null)
        localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }, entries);
}

/** Plant several maps and load the app on the first one.
 *  maps: [{id, rootText, branches}] — returns the docs keyed by map id. */
async function seedMaps(page, maps) {
  const entries = {
    'mindmaps.index.v1': maps.map(m => ({ id: m.id, title: m.rootText, updated: 1 })),
    'mindmaps.current.v1': maps[0].id, // stored raw, not JSON
  };
  const docs = {};
  for (const m of maps) {
    docs[m.id] = buildDoc(m.rootText, m.branches || []);
    entries['mindmaps.map.' + m.id] = docs[m.id];
  }
  await seedStorage(page, entries);
  await page.goto('/index.html');
  await page.waitForSelector('.mm-node[data-id="n0"]');
  return docs;
}

/** Plant a single map ('test1') and load the app on it. */
async function seedMap(page, rootText, branches, extraStorage) {
  if (extraStorage) await seedStorage(page, extraStorage);
  const docs = await seedMaps(page, [{ id: 'test1', rootText, branches }]);
  return docs.test1;
}

/** {focusId, editingId, rootId, currentMapId, undoDepth} from the debug hook. */
const mm = page => page.evaluate(() => window.__mm());

/** Parsed localStorage value (null when absent). */
const lsGet = (page, key) =>
  page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), key);

/** data-id of a node by its visible text (must be unique in the map). */
async function idOf(page, text) {
  return page.locator('.mm-node', { hasText: text }).getAttribute('data-id');
}

/** Focus a node by clicking it, then wait until the app agrees.
 *  (Clicking an already-focused node would start editing — skip that.) */
async function focusNode(page, id) {
  if ((await mm(page)).focusId === id) return;
  await page.locator(`.mm-node[data-id="${id}"]`).click();
  await page.waitForFunction(i => window.__mm().focusId === i, id);
}

/** Press an arrow key and return the focusId it landed on. */
async function arrow(page, key) {
  await page.keyboard.press(key);
  return (await mm(page)).focusId;
}

module.exports = { BRANCHES, buildDoc, seedStorage, seedMaps, seedMap, mm, lsGet, idOf, focusNode, arrow };
