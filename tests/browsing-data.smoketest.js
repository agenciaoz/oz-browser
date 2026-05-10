// OZ Browser — download-manager + history-manager smoke test (1.10b).

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')
const EventEmitter = require('events')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-bd-'))
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
  delete require.cache[require.resolve('../browser/download-manager.js')]
  delete require.cache[require.resolve('../browser/history-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
}

console.log('OZ Browser — browsing-data smoke test')

// -------- DownloadManager --------
section('download-manager: hookSession + record lifecycle')
{
  freshSetup()
  const { DownloadManager } = require('../browser/download-manager.js')
  const dm = new DownloadManager()

  // Fake session is an EventEmitter we can fire 'will-download' on.
  const session = new EventEmitter()
  dm.hookSession('id-1', session)
  ok('idempotent flag set', session._ozDownloadHooked === true)

  // Re-hook should noop
  const before = session.listenerCount('will-download')
  dm.hookSession('id-1', session)
  ok(
    're-hook noop (no extra listeners)',
    session.listenerCount('will-download') === before,
  )

  // Fire a will-download event with a fake DownloadItem
  const item = new EventEmitter()
  let savedPath = '/tmp/file.zip'
  Object.assign(item, {
    getFilename: () => 'file.zip',
    getSavePath: () => savedPath,
    getURL: () => 'https://example.com/file.zip',
    getMimeType: () => 'application/zip',
    getTotalBytes: () => 1024 * 1024,
    getReceivedBytes: () => 0,
  })
  session.emit('will-download', null, item)
  ok('1 download recorded', dm.list().length === 1)
  const rec = dm.list()[0]
  ok('record state progressing', rec.state === 'progressing')
  ok('filename', rec.filename === 'file.zip')
  ok('identityId', rec.identityId === 'id-1')

  // Fire 'done' event with state 'completed'
  item.getReceivedBytes = () => 1024 * 1024
  item.emit('done', null, 'completed')
  const after = dm.get(rec.id)
  ok('state completed', after.state === 'completed')
  ok('finishedAt set', after.finishedAt && after.finishedAt > 0)
  ok('receivedBytes', after.receivedBytes === 1024 * 1024)
}

section('download-manager: list filter + remove + clear')
{
  freshSetup()
  const { DownloadManager } = require('../browser/download-manager.js')
  const dm = new DownloadManager()
  const sessionA = new EventEmitter()
  const sessionB = new EventEmitter()
  dm.hookSession('id-A', sessionA)
  dm.hookSession('id-B', sessionB)
  function fire(session, filename, state) {
    const item = new EventEmitter()
    Object.assign(item, {
      getFilename: () => filename,
      getSavePath: () => `/tmp/${filename}`,
      getURL: () => `https://example.com/${filename}`,
      getMimeType: () => 'application/octet-stream',
      getTotalBytes: () => 100,
      getReceivedBytes: () => 100,
    })
    session.emit('will-download', null, item)
    if (state) item.emit('done', null, state)
  }
  fire(sessionA, 'a1.zip', 'completed')
  fire(sessionA, 'a2.zip', 'cancelled')
  fire(sessionB, 'b1.zip', 'completed')
  ok('total = 3', dm.list().length === 3)
  ok('filter id-A = 2', dm.list({ identityId: 'id-A' }).length === 2)
  ok('filter completed = 2', dm.list({ state: 'completed' }).length === 2)
  ok(
    'filter id-A + completed = 1',
    dm.list({ identityId: 'id-A', state: 'completed' }).length === 1,
  )
  // sort newest first
  ok('sorted newest first', dm.list()[0].startedAt >= dm.list()[1].startedAt)

  // Pick a specific id-A download to remove (not by sort order).
  // Original code used `dm.list()[0].id` which depends on sort-by-startedAt
  // being deterministic — flaky on fast runners (CI macos-latest) where
  // all 3 fire() calls land on the same Date.now() millisecond and the
  // sort tiebreaker is unstable. Removing by explicit id keeps b1.zip
  // available for the subsequent clear-by-identity assertion.
  const idAToRemove = dm.list({ identityId: 'id-A' })[0].id
  ok('remove ok', dm.remove(idAToRemove) === true)
  ok('total now 2', dm.list().length === 2)
  ok('remove unknown', dm.remove('nope') === false)

  ok('clear by identity = 1 (b1.zip)', dm.clear({ identityId: 'id-B' }) === 1)
  ok('total now 1', dm.list().length === 1)
  ok('clear all = 1', dm.clear() === 1)
  ok('empty', dm.list().length === 0)
}

// -------- HistoryManager --------
section('history-manager: addVisit + dedup + cap')
{
  freshSetup()
  const { HistoryManager } = require('../browser/history-manager.js')
  const hm = new HistoryManager({ saveDelayMs: 0 }) // sync save for tests
  const r1 = hm.addVisit({ identityId: 'id-1', url: 'https://x.com', title: 'X' })
  ok('addVisit returns record', !!r1 && r1.id)
  ok('total 1', hm.list().length === 1)
  // Dedup within 60s — second visit to same url merges
  const r2 = hm.addVisit({
    identityId: 'id-1',
    url: 'https://x.com',
    title: 'X Updated',
  })
  ok('still 1 entry (deduped)', hm.list().length === 1)
  ok('same id', r2.id === r1.id)
  ok('title updated', hm.list()[0].title === 'X Updated')

  // Different identity → new record
  hm.addVisit({ identityId: 'id-2', url: 'https://x.com', title: 'X' })
  ok('different identity adds new entry', hm.list().length === 2)

  // Skip about: + chrome-extension:
  const skip1 = hm.addVisit({ identityId: 'id-1', url: 'about:blank' })
  const skip2 = hm.addVisit({
    identityId: 'id-1',
    url: 'chrome-extension://abc/page.html',
  })
  ok('about: skipped', skip1 === null)
  ok('chrome-extension: skipped', skip2 === null)
  ok('total still 2', hm.list().length === 2)

  // Missing fields
  ok('no identityId → null', hm.addVisit({ url: 'https://y.com' }) === null)
  ok('no url → null', hm.addVisit({ identityId: 'id-1' }) === null)
}

section('history-manager: list filter + search + limit')
{
  freshSetup()
  const { HistoryManager } = require('../browser/history-manager.js')
  const hm = new HistoryManager({ saveDelayMs: 0 })
  for (let i = 0; i < 5; i++) {
    hm.addVisit({
      identityId: 'id-1',
      url: `https://example.com/page${i}`,
      title: `Page ${i}`,
    })
    hm.addVisit({
      identityId: 'id-2',
      url: `https://other.com/x${i}`,
      title: `X${i}`,
    })
  }
  ok('total 10', hm.list().length === 10)
  ok('filter id-1 = 5', hm.list({ identityId: 'id-1' }).length === 5)
  ok('search "page" = 5', hm.list({ search: 'page' }).length === 5)
  ok('search "X3" = 1 (case-insensitive)', hm.list({ search: 'x3' }).length === 1)
  ok('limit 3', hm.list({ limit: 3 }).length === 3)
  ok(
    'combined: id-1 + search page = 5',
    hm.list({ identityId: 'id-1', search: 'page' }).length === 5,
  )
}

section('history-manager: persistence round-trip + clear')
{
  freshSetup()
  const { HistoryManager } = require('../browser/history-manager.js')
  const hm = new HistoryManager({ saveDelayMs: 0 })
  hm.addVisit({ identityId: 'id-1', url: 'https://persist.com', title: 'Persist' })
  hm.addVisit({ identityId: 'id-2', url: 'https://other.com', title: 'Other' })
  hm.flush()

  delete require.cache[require.resolve('../browser/history-manager.js')]
  const { HistoryManager: HM2 } = require('../browser/history-manager.js')
  const hm2 = new HM2({ saveDelayMs: 0 })
  ok('round-trip count 2', hm2.list().length === 2)

  // Clear by identity
  ok('clear id-1 = 1', hm2.clear({ identityId: 'id-1' }) === 1)
  ok('total now 1', hm2.list().length === 1)
  // Clear all
  ok('clear all = 1', hm2.clear() === 1)
  ok('empty', hm2.list().length === 0)
}

section('history-manager: hookTabs auto-records did-navigate')
{
  freshSetup()
  const { HistoryManager } = require('../browser/history-manager.js')
  const hm = new HistoryManager({ saveDelayMs: 0 })
  // FakeTabs is an EventEmitter that emits tab-updated
  const tabs = new EventEmitter()
  hm.hookTabs(tabs)
  ok('hooked flag', tabs._ozHistoryHooked === true)
  // Re-hook noop
  const before = tabs.listenerCount('tab-updated')
  hm.hookTabs(tabs)
  ok('re-hook noop', tabs.listenerCount('tab-updated') === before)
  // Fire event
  const fakeTab = { identityId: 'id-1' }
  tabs.emit('tab-updated', fakeTab, {
    url: 'https://hooked.com',
    title: 'Hooked',
    favicon: null,
  })
  ok('history captured tab event', hm.list().length === 1)
  ok('captured url', hm.list()[0].url === 'https://hooked.com')
}

// ---------- Cleanup --------------------------------------------------------
Module._load = originalLoad
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
