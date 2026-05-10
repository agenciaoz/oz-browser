// OZ Browser — bookmark-manager + bookmark-handlers smoke test (1.7b).
//
// Cómo correr:
//   cd oz-browser
//   node tests/bookmark-manager.smoketest.js
//
// Cubre:
//   - BookmarkManager: add, get, list, remove, dedup, persistence round-trip
//   - bookmark-handlers: addFromTab via fake browser
//
// Approach: fake Electron app + tmp userData. Sin GUI, sin sessions reales.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-bm-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

let passed = 0
let failed = 0
const failures = []
function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push({ label, detail })
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}
function section(name) {
  console.log(`\n— ${name} —`)
}

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/bookmark-manager.js')]
  delete require.cache[require.resolve('../browser/bookmark-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { BookmarkManager } = require('../browser/bookmark-manager.js')
  const { buildBookmarkHandlers } = require('../browser/bookmark-handlers.js')
  return { BookmarkManager, buildBookmarkHandlers }
}

console.log('OZ Browser — bookmark-manager + handlers smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. add + list + get
section('add: basic CRUD')
{
  const { BookmarkManager } = freshSetup()
  const bm = new BookmarkManager()
  ok('list initially empty', bm.list().length === 0)

  const b = bm.add({
    identityId: 'id-1',
    url: 'https://x.com',
    title: 'X',
    favicon: null,
  })
  ok('add returns bookmark', !!b && !!b.id)
  ok('id is uuid hex', typeof b.id === 'string' && b.id.length === 16)
  ok('list now has 1', bm.list().length === 1)
  ok('get round-trips', bm.get(b.id).url === 'https://x.com')
}

// 2. dedup
section('dedup: same identity+url returns existing')
{
  const { BookmarkManager } = freshSetup()
  const bm = new BookmarkManager()
  const a = bm.add({ identityId: 'id-1', url: 'https://x.com', title: 'X' })
  const b = bm.add({ identityId: 'id-1', url: 'https://x.com', title: 'X 2nd' })
  ok('list still has 1 (dedup)', bm.list().length === 1)
  ok('returned existing id', b.id === a.id)
  ok('deduped flag set on second add', b.deduped === true)
}

// 3. dedup is per-identity
section('dedup: same url different identity → 2 bookmarks')
{
  const { BookmarkManager } = freshSetup()
  const bm = new BookmarkManager()
  bm.add({ identityId: 'id-1', url: 'https://x.com', title: 'X' })
  bm.add({ identityId: 'id-2', url: 'https://x.com', title: 'X' })
  ok('list has 2', bm.list().length === 2)
  ok('list({id-1}) has 1', bm.list({ identityId: 'id-1' }).length === 1)
  ok('list({id-2}) has 1', bm.list({ identityId: 'id-2' }).length === 1)
}

// 4. validation
section('add: missing fields rejected')
{
  const { BookmarkManager } = freshSetup()
  const bm = new BookmarkManager()
  ok('add({}) returns null', bm.add({}) === null)
  ok('add({identityId only}) returns null', bm.add({ identityId: 'x' }) === null)
  ok('add({url only}) returns null', bm.add({ url: 'https://x' }) === null)
  ok('list still empty', bm.list().length === 0)
}

// 5. remove
section('remove: by id + by identity bulk')
{
  const { BookmarkManager } = freshSetup()
  const bm = new BookmarkManager()
  const a = bm.add({ identityId: 'id-1', url: 'https://a.com', title: 'A' })
  const b = bm.add({ identityId: 'id-1', url: 'https://b.com', title: 'B' })
  bm.add({ identityId: 'id-2', url: 'https://c.com', title: 'C' })

  ok('remove ok', bm.remove(a.id) === true)
  ok('list has 2', bm.list().length === 2)
  ok('removed gone', bm.get(a.id) === null)
  ok('remove unknown returns false', bm.remove('nope') === false)

  // Bulk by identity
  const deleted = bm.removeByIdentity('id-1')
  ok('removeByIdentity returns count 1', deleted === 1)
  ok('list has 1 (only id-2 left)', bm.list().length === 1)
  ok('id-2 bookmark survives', bm.list()[0].identityId === 'id-2')
  void b // avoid unused
}

// 6. persistence round-trip
section('persistence: write then re-instantiate')
{
  const { BookmarkManager } = freshSetup()
  const bm1 = new BookmarkManager()
  bm1.add({ identityId: 'id-1', url: 'https://persist.com', title: 'Persist' })
  bm1.add({ identityId: 'id-2', url: 'https://other.com', title: 'Other' })
  // New instance reading the same file
  const bm2 = new BookmarkManager()
  ok('round-trip count', bm2.list().length === 2)
  const persist = bm2.list().find((b) => b.url === 'https://persist.com')
  ok('persist bookmark survives', !!persist && persist.title === 'Persist')
}

// 7. addFromTab via handlers
section('handlers.addFromTab: resolves from window registry')
{
  const { BookmarkManager, buildBookmarkHandlers } = freshSetup()
  const bm = new BookmarkManager()
  const fakeTab = {
    id: 't1',
    identityId: 'id-1',
    url: 'https://from-tab.com',
    title: 'From Tab',
    favicon: null,
    serialize() {
      return {
        id: this.id,
        identityId: this.identityId,
        url: this.url,
        title: this.title,
        favicon: this.favicon,
      }
    },
  }
  const fakeWin = { id: 1, tabs: { get: (id) => (id === 't1' ? fakeTab : null) } }
  const browser = {
    bookmarkManager: bm,
    windows: [fakeWin],
    broadcastToWebUI() {},
  }
  const h = buildBookmarkHandlers(browser)

  const r = h.addFromTab('t1')
  ok('ok', r.ok === true)
  ok('bookmark added', !!r.bookmark && r.bookmark.url === 'https://from-tab.com')
  ok('list has 1', bm.list().length === 1)

  // Re-add same tab → dedup
  const r2 = h.addFromTab('t1')
  ok('re-add ok', r2.ok === true)
  ok('list still has 1 (dedup)', bm.list().length === 1)
  ok('deduped flag', r2.bookmark.deduped === true)

  // Tab not found
  const r3 = h.addFromTab('does-not-exist')
  ok('not-found returns ok:false', r3.ok === false)
  ok('reason tab-not-found', r3.reason === 'tab-not-found')
}

// 8. handlers.list with filter
section('handlers.list: identityId filter')
{
  const { BookmarkManager, buildBookmarkHandlers } = freshSetup()
  const bm = new BookmarkManager()
  bm.add({ identityId: 'a', url: 'https://1.com', title: '1' })
  bm.add({ identityId: 'a', url: 'https://2.com', title: '2' })
  bm.add({ identityId: 'b', url: 'https://3.com', title: '3' })
  const browser = { bookmarkManager: bm, broadcastToWebUI() {}, windows: [] }
  const h = buildBookmarkHandlers(browser)
  ok('all = 3', h.list().length === 3)
  ok('filter a = 2', h.list({ identityId: 'a' }).length === 2)
  ok('filter b = 1', h.list({ identityId: 'b' }).length === 1)
}

// 9. clearBrowsingData (1.7b) — storages selection per scope (async)
async function runClearTests() {
  section('identity-handlers.clearBrowsingData: storages per scope')
  delete require.cache[require.resolve('../browser/identity-handlers.js')]
  const { buildIdentityHandlers } = require('../browser/identity-handlers.js')

  // Capture clearStorageData / clearCache calls.
  const calls = []
  const fakeSes = {
    async clearStorageData(opts) {
      calls.push({ method: 'clearStorageData', storages: opts.storages })
    },
    async clearCache() {
      calls.push({ method: 'clearCache' })
    },
  }
  const fakeIdent = { id: 'id-1', name: 'A', isDefault: false }
  const fakeIM = {
    get: (id) => (id === 'id-1' ? fakeIdent : null),
    getDefault: () => fakeIdent,
    getSession: () => fakeSes,
  }
  const browser = {
    activeIdentityId: 'id-1',
    identityManager: fakeIM,
    broadcastToWebUI() {},
  }
  const h = buildIdentityHandlers(browser)

  calls.length = 0
  const r1 = await h.clearBrowsingData('id-1', 'cookies')
  ok('cookies scope ok', r1.ok === true)
  ok(
    'cookies scope = ["cookies"]',
    JSON.stringify(r1.clearedStorages) === JSON.stringify(['cookies']),
  )
  ok('clearCache NOT called for cookies', !calls.some((c) => c.method === 'clearCache'))

  calls.length = 0
  const r2 = await h.clearBrowsingData('id-1', 'storage')
  ok('storage scope ok', r2.ok === true)
  ok('storage scope excludes cookies', !r2.clearedStorages.includes('cookies'))
  ok('storage scope includes localstorage', r2.clearedStorages.includes('localstorage'))
  ok(
    'clearCache called for storage scope',
    calls.some((c) => c.method === 'clearCache'),
  )

  calls.length = 0
  const r3 = await h.clearBrowsingData('id-1', 'both')
  ok('both scope ok', r3.ok === true)
  ok('both scope includes cookies', r3.clearedStorages.includes('cookies'))
  ok('both scope includes localstorage', r3.clearedStorages.includes('localstorage'))
  ok(
    'clearCache called for both',
    calls.some((c) => c.method === 'clearCache'),
  )

  const r4 = await h.clearBrowsingData('does-not-exist', 'both')
  ok('not-found returns ok:false', r4.ok === false)
  ok('reason identity-not-found', r4.reason === 'identity-not-found')

  const r5 = await h.clearBrowsingData('id-1', 'invalid-scope')
  ok('invalid scope returns ok:false', r5.ok === false)
  ok('reason invalid-scope', r5.reason === 'invalid-scope')
}

// ---------- Cleanup ---------------------------------------------------------

runClearTests()
  .then(() => {
    Module._load = originalLoad
    console.log(`\n=== ${passed} passed · ${failed} failed ===`)
    if (failed > 0) {
      console.log('\nFailures:')
      for (const f of failures)
        console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
      process.exit(1)
    }
    process.exit(0)
  })
  .catch((err) => {
    console.error('runClearTests error:', err)
    process.exit(1)
  })
