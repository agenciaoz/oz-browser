// OZ Browser — BulkRateLimit smoke test (v2 sub-bloque 6).

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

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

async function main() {
  const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bulk-rate-'))

  // Fixed clock for deterministic day keys.
  const T = Date.UTC(2026, 4, 22, 12, 0, 0) // 2026-05-22 12:00 UTC

  section('default caps')
  {
    const reg = new BulkRateLimit({ userDataDir: TEST_HOME, clock: fixedClock(T) })
    ok('IG follow cap = 150', reg.getCap('instagram.com', 'ig_follow') === 150)
    ok('IG like cap = 200', reg.getCap('instagram.com', 'ig_like') === 200)
    ok('X like cap = 500', reg.getCap('x.com', 'x_like') === 500)
    ok('TikTok like cap = 500', reg.getCap('tiktok.com', 'tiktok_like') === 500)
    ok('FB like cap = 300', reg.getCap('facebook.com', 'fb_like') === 300)
    ok('unknown platform → Infinity', reg.getCap('unknown.com', 'whatever') === Infinity)
    ok(
      'unknown action falls back to _default',
      reg.getCap('instagram.com', 'unknown_action') === 100,
    )
  }

  section('increment + getCount + wouldExceed')
  {
    const dir = path.join(TEST_HOME, 'r2')
    const reg = new BulkRateLimit({ userDataDir: dir, clock: fixedClock(T) })
    ok('initial count = 0', reg.getCount('id1', 'x.com', 'x_like') === 0)
    ok('wouldExceed = false initially', !reg.wouldExceed('id1', 'x.com', 'x_like'))
    reg.increment('id1', 'x.com', 'x_like')
    ok('count after increment = 1', reg.getCount('id1', 'x.com', 'x_like') === 1)
    // Pump counter to cap.
    for (let i = 0; i < 499; i++) reg.increment('id1', 'x.com', 'x_like')
    ok('count at cap = 500', reg.getCount('id1', 'x.com', 'x_like') === 500)
    ok('wouldExceed = true at cap', reg.wouldExceed('id1', 'x.com', 'x_like'))
    // Other (identity, action) combos unaffected.
    ok('different identity unaffected', !reg.wouldExceed('id2', 'x.com', 'x_like'))
    ok('different action unaffected', !reg.wouldExceed('id1', 'x.com', 'x_post'))
  }

  section('persistence: load after restart')
  {
    const dir = path.join(TEST_HOME, 'r3')
    const reg1 = new BulkRateLimit({ userDataDir: dir, clock: fixedClock(T) })
    reg1.increment('id1', 'instagram.com', 'ig_like')
    reg1.increment('id1', 'instagram.com', 'ig_like')
    reg1.increment('id1', 'instagram.com', 'ig_like')
    // Fresh instance, same dir + same day.
    const reg2 = new BulkRateLimit({ userDataDir: dir, clock: fixedClock(T) })
    ok('count survives restart', reg2.getCount('id1', 'instagram.com', 'ig_like') === 3)
  }

  section('day rollover: new day = new bucket')
  {
    const dir = path.join(TEST_HOME, 'r4')
    const day1 = Date.UTC(2026, 4, 22, 12, 0, 0)
    const day2 = Date.UTC(2026, 4, 23, 12, 0, 0)
    const reg = new BulkRateLimit({ userDataDir: dir, clock: { now: () => day1 } })
    for (let i = 0; i < 150; i++) reg.increment('id1', 'instagram.com', 'ig_follow')
    ok('hit cap on day 1', reg.wouldExceed('id1', 'instagram.com', 'ig_follow'))
    // Advance clock to next day.
    reg.clock = { now: () => day2 }
    ok('day 2 starts fresh', reg.getCount('id1', 'instagram.com', 'ig_follow') === 0)
    ok(
      'wouldExceed = false on day 2',
      !reg.wouldExceed('id1', 'instagram.com', 'ig_follow'),
    )
  }

  section('purgeOldEntries')
  {
    const dir = path.join(TEST_HOME, 'r5')
    const old = Date.UTC(2026, 3, 1, 12, 0, 0) // 2026-04-01
    const now = Date.UTC(2026, 4, 22, 12, 0, 0) // 2026-05-22 — 51 days later
    const reg = new BulkRateLimit({ userDataDir: dir, clock: { now: () => old } })
    reg.increment('id1', 'x.com', 'x_like')
    reg.clock = { now: () => now }
    reg.increment('id2', 'x.com', 'x_like')
    const before = Object.keys(reg.stats()).length
    ok('two entries before purge', before === 2)
    const removed = reg.purgeOldEntries(30)
    ok('purged 1 entry', removed === 1)
    const after = Object.keys(reg.stats()).length
    ok('one entry remains', after === 1)
  }

  section('overrides via opts.caps')
  {
    const dir = path.join(TEST_HOME, 'r6')
    const reg = new BulkRateLimit({
      userDataDir: dir,
      clock: fixedClock(T),
      caps: { 'instagram.com': { ig_like: 5 } },
    })
    ok('override applied', reg.getCap('instagram.com', 'ig_like') === 5)
    ok('other caps unaffected', reg.getCap('instagram.com', 'ig_follow') === 150)
    for (let i = 0; i < 5; i++) reg.increment('id1', 'instagram.com', 'ig_like')
    ok(
      'wouldExceed = true at override cap',
      reg.wouldExceed('id1', 'instagram.com', 'ig_like'),
    )
  }

  section('platform agnostic action (no cap)')
  {
    const dir = path.join(TEST_HOME, 'r7')
    const reg = new BulkRateLimit({ userDataDir: dir, clock: fixedClock(T) })
    // Echo / navigate would pass null platform — guarded at runner level
    // but registry handles gracefully.
    ok('null platform cap = Infinity', reg.getCap(null, 'echo') === Infinity)
    ok('unknown platform never exceeds', !reg.wouldExceed('id1', 'random.com', 'echo'))
  }

  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error('crashed:', err)
  process.exit(1)
})
