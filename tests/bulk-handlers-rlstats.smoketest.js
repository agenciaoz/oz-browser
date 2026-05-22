// OZ Browser — bulk-handlers.rateLimitStats() smoke test (v2 Etapa 2.2).
//
// Verifies the IPC/MCP-exposed shape of the rate-limit stats handler:
//   - returns { asOf, entries:[{identityId, platform, actionId, day, count, cap, remaining}] }
//   - filters by identityId when provided
//   - resolves cap/remaining for platform actions (IG like = 200)
//   - returns cap=null / remaining=null for platform-agnostic actions (echo)
//   - returns __error when bulkRateLimit is missing on browser
//   - tolerates malformed opts

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const { buildBulkHandlers } = require('../browser/bulk-handlers')
const { BulkRateLimit } = require('../browser/bulk-rate-limit')

let passed = 0
let failed = 0

function ok(label, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? '\n      ' + detail : ''}`)
  }
}

function section(name) {
  console.log(`\n— ${name} —`)
}

function fixedClock(epochMs) {
  return { now: () => epochMs }
}

// Minimal fake runner + registry so buildBulkHandlers doesn't throw.
function makeBrowser({ rateLimit }) {
  const runner = {
    _wiredToBroadcast: true, // skip broadcast wiring
    on: () => {},
  }
  const registry = { list: () => [] }
  return {
    bulkRunner: runner,
    bulkActionsRegistry: registry,
    bulkRateLimit: rateLimit,
    broadcastToWebUI: () => {},
  }
}

async function main() {
  const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bulk-rlstats-'))
  const T = Date.UTC(2026, 4, 22, 12, 0, 0) // 2026-05-22 12:00 UTC
  const TODAY = '2026-05-22'

  section('returns empty entries when registry has no counters')
  {
    const rl = new BulkRateLimit({ userDataDir: TEST_HOME, clock: fixedClock(T) })
    const h = buildBulkHandlers(makeBrowser({ rateLimit: rl }))
    const out = h.rateLimitStats()
    ok('shape: asOf is today', out.asOf === TODAY, `got ${out && out.asOf}`)
    ok(
      'shape: entries is empty array',
      Array.isArray(out.entries) && out.entries.length === 0,
    )
  }

  section('reflects increments + resolves cap/remaining')
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bulk-rlstats-2-'))
    const rl = new BulkRateLimit({ userDataDir: dir, clock: fixedClock(T) })
    rl.increment('id-1', 'instagram.com', 'ig_like')
    rl.increment('id-1', 'instagram.com', 'ig_like')
    rl.increment('id-1', 'instagram.com', 'ig_like')
    rl.increment('id-2', 'x.com', 'x_post')
    rl.increment('id-1', null, 'echo') // platform-agnostic

    const h = buildBulkHandlers(makeBrowser({ rateLimit: rl }))
    const out = h.rateLimitStats()
    const entries = out.entries

    const igLike = entries.find(
      (e) => e.identityId === 'id-1' && e.actionId === 'ig_like',
    )
    ok('id-1 ig_like present', !!igLike, JSON.stringify(entries))
    ok('id-1 ig_like count=3', igLike && igLike.count === 3, JSON.stringify(igLike))
    ok('id-1 ig_like cap=200', igLike && igLike.cap === 200, JSON.stringify(igLike))
    ok(
      'id-1 ig_like remaining=197',
      igLike && igLike.remaining === 197,
      JSON.stringify(igLike),
    )
    ok('id-1 ig_like day matches', igLike && igLike.day === TODAY, JSON.stringify(igLike))
    ok(
      'id-1 ig_like platform preserved',
      igLike && igLike.platform === 'instagram.com',
      JSON.stringify(igLike),
    )

    const xPost = entries.find((e) => e.actionId === 'x_post')
    ok('id-2 x_post cap=100', xPost && xPost.cap === 100, JSON.stringify(xPost))
    ok('id-2 x_post remaining=99', xPost && xPost.remaining === 99, JSON.stringify(xPost))

    const echoEntry = entries.find((e) => e.actionId === 'echo')
    ok(
      'echo platform=null',
      echoEntry && echoEntry.platform === null,
      JSON.stringify(echoEntry),
    )
    ok(
      'echo cap=null (platform-agnostic Infinity → null)',
      echoEntry && echoEntry.cap === null,
      JSON.stringify(echoEntry),
    )
    ok(
      'echo remaining=null',
      echoEntry && echoEntry.remaining === null,
      JSON.stringify(echoEntry),
    )

    // sorted: id-1 entries come before id-2
    const ids = entries.map((e) => e.identityId)
    ok(
      'entries sorted by identityId',
      ids.indexOf('id-1') < ids.indexOf('id-2'),
      JSON.stringify(ids),
    )
  }

  section('filters by identityId')
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bulk-rlstats-3-'))
    const rl = new BulkRateLimit({ userDataDir: dir, clock: fixedClock(T) })
    rl.increment('alice', 'instagram.com', 'ig_like')
    rl.increment('bob', 'instagram.com', 'ig_like')
    rl.increment('bob', 'x.com', 'x_like')

    const h = buildBulkHandlers(makeBrowser({ rateLimit: rl }))
    const onlyBob = h.rateLimitStats({ identityId: 'bob' })
    ok('filter: 2 bob entries', onlyBob.entries.length === 2, JSON.stringify(onlyBob))
    ok(
      'filter: all entries are bob',
      onlyBob.entries.every((e) => e.identityId === 'bob'),
      JSON.stringify(onlyBob),
    )

    const all = h.rateLimitStats({})
    ok('no filter: 3 entries', all.entries.length === 3, JSON.stringify(all))
  }

  section('error path when registry missing')
  {
    const h = buildBulkHandlers(makeBrowser({ rateLimit: null }))
    const out = h.rateLimitStats()
    ok(
      'returns __error',
      out && out.__error && out.__error.code === 'NOT_AVAILABLE',
      JSON.stringify(out),
    )
  }

  section('malformed opts treated as no-filter')
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bulk-rlstats-4-'))
    const rl = new BulkRateLimit({ userDataDir: dir, clock: fixedClock(T) })
    rl.increment('alice', 'instagram.com', 'ig_like')

    const h = buildBulkHandlers(makeBrowser({ rateLimit: rl }))
    const out1 = h.rateLimitStats('not-an-object')
    ok(
      'string opts → still works',
      Array.isArray(out1.entries) && out1.entries.length === 1,
    )
    const out2 = h.rateLimitStats(null)
    ok(
      'null opts → still works',
      Array.isArray(out2.entries) && out2.entries.length === 1,
    )
    const out3 = h.rateLimitStats({ identityId: 42 })
    ok(
      'non-string identityId ignored',
      Array.isArray(out3.entries) && out3.entries.length === 1,
    )
  }

  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
