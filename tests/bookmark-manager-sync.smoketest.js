// OZ Browser — BookmarkManager sync smoke test (D-4 mini b CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/bookmark-manager-sync.smoketest.js
//
// Cubre:
//   - BookmarkManager extends EventEmitter
//   - add() stamps _updatedAt + emits 'changed' op=update recordId='all'
//   - remove() stamps + emits
//   - removeByIdentity() stamps + emits when something deleted; no emit when no-op
//   - _updatedAt persists in sidecar bookmarks-sync-meta.json
//   - getSyncRecord() returns {id:'all', updatedAt, bookmarks: [...]}
//   - applyRemoteUpsert replaces local bookmarks with body.bookmarks
//   - applyRemoteUpsert does NOT emit 'changed' (avoids push loop)
//   - applyRemoteUpsert emits 'remote-applied' with count + updatedAt
//   - applyRemoteUpsert validation: invalid body / wrong recordId / non-array bookmarks
//   - applyRemoteUpsert drops malformed entries (defensive)
//   - applyRemoteDelete is a no-op + warn (bookmarks have no tombstone)
//   - end-to-end: legacy bookmarks.json (no sidecar) → load OK + nowIso fallback

'use strict'

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---------- Electron mock ---------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-bmsync-'))
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
    on() {},
    whenReady: () => Promise.resolve(),
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

// ---------- Test runner -----------------------------------------------------

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

function freshBM() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/bookmark-manager.js')]
  delete require.cache[require.resolve('../browser/bookmark-manager-sync.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const {
    BookmarkManager,
    BOOKMARKS_RECORD_ID,
  } = require('../browser/bookmark-manager.js')
  const {
    applyRemoteUpsert,
    applyRemoteDelete,
  } = require('../browser/bookmark-manager-sync.js')
  return { BookmarkManager, BOOKMARKS_RECORD_ID, applyRemoteUpsert, applyRemoteDelete }
}

console.log('OZ Browser — bookmark-manager-sync smoke test')

// 1. EventEmitter + add stamps + emits
section('add → stamp + emit')
{
  const { BookmarkManager } = freshBM()
  const bm = new BookmarkManager()
  ok(
    'BookmarkManager is an EventEmitter',
    typeof bm.on === 'function' && typeof bm.emit === 'function',
  )

  const events = []
  bm.on('changed', (e) => events.push(e))

  const b = bm.add({ identityId: 'id-1', url: 'https://example.com', title: 'Ex' })
  ok('add returned a bookmark', b && typeof b.id === 'string')
  ok('events.length === 1', events.length === 1)
  ok("event.op === 'update'", events[0].op === 'update')
  ok("event.recordType === 'bookmark'", events[0].recordType === 'bookmark')
  ok("event.recordId === 'all'", events[0].recordId === 'all')
  ok(
    'event.updatedAt is ISO',
    typeof events[0].updatedAt === 'string' &&
      !Number.isNaN(Date.parse(events[0].updatedAt)),
  )
  ok('bm.getUpdatedAt() matches event', bm.getUpdatedAt() === events[0].updatedAt)
}

// 2. Duplicate add does NOT emit (dedup'd)
section('Duplicate add (deduped) → no emit')
{
  const { BookmarkManager } = freshBM()
  const bm = new BookmarkManager()
  const events = []
  bm.add({ identityId: 'id-1', url: 'https://x.com' })
  bm.on('changed', (e) => events.push(e))
  const r = bm.add({ identityId: 'id-1', url: 'https://x.com' })
  ok('dedup returns existing with deduped:true', r && r.deduped === true)
  ok('no extra change event fired (dedup)', events.length === 0)
}

// 3. remove() stamps + emits
section('remove → stamp + emit')
{
  const { BookmarkManager } = freshBM()
  const bm = new BookmarkManager()
  const b = bm.add({ identityId: 'id-1', url: 'https://x.com' })
  const ts1 = bm.getUpdatedAt()
  // tick forward 1ms
  const start = Date.now()
  while (Date.now() === start) {
    /* spin */
  }
  const events = []
  bm.on('changed', (e) => events.push(e))
  ok('remove returned true', bm.remove(b.id) === true)
  ok('removed event fired', events.length === 1)
  ok('updatedAt advanced', bm.getUpdatedAt() > ts1)
}

// 4. removeByIdentity → stamp + emit only when actually deleted
section('removeByIdentity → conditional emit')
{
  const { BookmarkManager } = freshBM()
  const bm = new BookmarkManager()
  bm.add({ identityId: 'id-a', url: 'https://a.com' })
  bm.add({ identityId: 'id-a', url: 'https://b.com' })
  bm.add({ identityId: 'id-b', url: 'https://c.com' })
  const events = []
  bm.on('changed', (e) => events.push(e))
  const deleted = bm.removeByIdentity('id-a')
  ok('removeByIdentity returned 2', deleted === 2)
  ok('1 change event fired', events.length === 1)

  events.length = 0
  const noopDeleted = bm.removeByIdentity('id-nonexistent')
  ok('noop removeByIdentity returns 0', noopDeleted === 0)
  ok('no extra event on noop', events.length === 0)
}

// 5. Sidecar meta persistence
section('Sidecar meta persists across instances')
{
  const { BookmarkManager } = freshBM()
  const bm1 = new BookmarkManager()
  bm1.add({ identityId: 'id-1', url: 'https://persist.com' })
  const ts = bm1.getUpdatedAt()
  ok('first instance has updatedAt', typeof ts === 'string')

  // Verify the sidecar file exists
  const metaPath = path.join(TEST_USERDATA, 'bookmarks-sync-meta.json')
  ok('sidecar file exists', fs.existsSync(metaPath))
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  ok('meta.schemaVersion === 1', meta.schemaVersion === 1)
  ok('meta.updatedAt matches', meta.updatedAt === ts)

  // New instance, same userdata
  delete require.cache[require.resolve('../browser/bookmark-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { BookmarkManager: BM2 } = require('../browser/bookmark-manager.js')
  const bm2 = new BM2()
  ok('second instance loaded updatedAt from sidecar', bm2.getUpdatedAt() === ts)
}

// 6. getSyncRecord() shape
section('getSyncRecord()')
{
  const { BookmarkManager } = freshBM()
  const bm = new BookmarkManager()
  bm.add({ identityId: 'id-1', url: 'https://a.com', title: 'A' })
  bm.add({ identityId: 'id-2', url: 'https://b.com', title: 'B' })
  const rec = bm.getSyncRecord()
  ok("rec.id === 'all'", rec.id === 'all')
  ok('rec.bookmarks.length === 2', rec.bookmarks.length === 2)
  ok(
    'rec.updatedAt is ISO',
    typeof rec.updatedAt === 'string' && !Number.isNaN(Date.parse(rec.updatedAt)),
  )
  // Mutating the returned record does NOT affect the manager
  rec.bookmarks.push({ id: 'fake', url: 'fake', identityId: 'fake' })
  ok('rec returns a copy (mutation safe)', bm.bookmarks.length === 2)
}

// 7. applyRemoteUpsert replaces local + does NOT emit 'changed'
section('applyRemoteUpsert: replaces local + no changed emit')
{
  const { BookmarkManager, applyRemoteUpsert } = freshBM()
  const bm = new BookmarkManager()
  bm.add({ identityId: 'id-local', url: 'https://will-be-replaced.com' })

  const changes = []
  const remoteApplied = []
  bm.on('changed', (e) => changes.push(e))
  bm.on('remote-applied', (e) => remoteApplied.push(e))

  const remoteBody = {
    id: 'all',
    updatedAt: '2026-05-11T12:00:00.000Z',
    bookmarks: [
      { id: 'r1', identityId: 'remote-id', url: 'https://from-bob.com', title: 'Bob 1' },
      {
        id: 'r2',
        identityId: 'remote-id',
        url: 'https://from-bob-2.com',
        title: 'Bob 2',
      },
    ],
  }
  const result = applyRemoteUpsert(bm, remoteBody)
  ok("result.op === 'update'", result && result.op === 'update')
  ok('result.count === 2', result.count === 2)
  ok('local bookmarks replaced (length 2)', bm.bookmarks.length === 2)
  ok(
    'local bookmarks NO contain old local one',
    !bm.bookmarks.find((b) => b.url === 'https://will-be-replaced.com'),
  )
  ok(
    'local bookmarks contain remote ones',
    bm.bookmarks.find((b) => b.url === 'https://from-bob.com'),
  )
  ok('local updatedAt set from remote', bm.getUpdatedAt() === '2026-05-11T12:00:00.000Z')
  ok("no 'changed' emit on apply", changes.length === 0)
  ok('1 remote-applied emit', remoteApplied.length === 1)
  ok("remote-applied recordType='bookmark'", remoteApplied[0].recordType === 'bookmark')
  ok("remote-applied recordId='all'", remoteApplied[0].recordId === 'all')
  ok('remote-applied count === 2', remoteApplied[0].count === 2)
}

// 8. applyRemoteUpsert validation
section('applyRemoteUpsert: validation')
{
  const { BookmarkManager, applyRemoteUpsert } = freshBM()
  const bm = new BookmarkManager()
  ok('null body → null', applyRemoteUpsert(bm, null) === null)
  ok(
    'wrong recordId → null',
    applyRemoteUpsert(bm, { id: 'not-all', bookmarks: [] }) === null,
  )
  ok(
    'non-array bookmarks → null',
    applyRemoteUpsert(bm, { id: 'all', bookmarks: 'nope' }) === null,
  )
}

// 9. applyRemoteUpsert drops malformed entries
section('applyRemoteUpsert: drops malformed entries')
{
  const { BookmarkManager, applyRemoteUpsert } = freshBM()
  const bm = new BookmarkManager()
  const result = applyRemoteUpsert(bm, {
    id: 'all',
    updatedAt: '2026-05-11T12:00:00.000Z',
    bookmarks: [
      { id: 'ok-1', identityId: 'id-a', url: 'https://ok.com' },
      { id: 'no-url' /* missing url */, identityId: 'id-a' },
      null,
      'string-not-object',
      { id: 'ok-2', identityId: 'id-b', url: 'https://ok2.com' },
    ],
  })
  ok('result.count === 2 (malformed dropped)', result.count === 2)
  ok('bm.bookmarks.length === 2', bm.bookmarks.length === 2)
}

// 10. applyRemoteUpsert with missing updatedAt → backfills
section('applyRemoteUpsert: defensive updatedAt backfill')
{
  const { BookmarkManager, applyRemoteUpsert } = freshBM()
  const bm = new BookmarkManager()
  applyRemoteUpsert(bm, {
    id: 'all',
    bookmarks: [{ id: 'b1', identityId: 'i1', url: 'https://x.com' }],
    // no updatedAt
  })
  ok(
    'updatedAt backfilled to ISO',
    typeof bm.getUpdatedAt() === 'string' && !Number.isNaN(Date.parse(bm.getUpdatedAt())),
  )
}

// 11. applyRemoteDelete is a no-op + warn
section('applyRemoteDelete: no-op')
{
  const { BookmarkManager, applyRemoteDelete } = freshBM()
  const bm = new BookmarkManager()
  bm.add({ identityId: 'id-1', url: 'https://stays.com' })
  const result = applyRemoteDelete(bm, 'all', '2026-05-11T12:00:00.000Z')
  ok('returns null', result === null)
  ok('bookmarks unchanged', bm.bookmarks.length === 1)
}

// 12. Legacy bookmarks.json (no sidecar) → load OK + nowIso fallback
section('Legacy bookmarks.json (no sidecar)')
{
  const { BookmarkManager } = freshBM()
  // Seed legacy bookmarks.json directly (no sidecar)
  fs.writeFileSync(
    path.join(TEST_USERDATA, 'bookmarks.json'),
    JSON.stringify([
      { id: 'legacy-1', identityId: 'id-legacy', url: 'https://legacy.com' },
    ]),
  )
  delete require.cache[require.resolve('../browser/bookmark-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { BookmarkManager: BM } = require('../browser/bookmark-manager.js')
  const bm = new BM()
  ok('legacy bookmark loaded', bm.bookmarks.length === 1)
  ok('legacy bookmark.id preserved', bm.bookmarks[0].id === 'legacy-1')
  ok('updatedAt is null (no sidecar)', bm.getUpdatedAt() === null)
  // getSyncRecord still works — backfills updatedAt
  const rec = bm.getSyncRecord()
  ok(
    'getSyncRecord backfills updatedAt',
    typeof rec.updatedAt === 'string' && !Number.isNaN(Date.parse(rec.updatedAt)),
  )
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
