// OZ Browser — Publishing analytics smoke test (E7 pulido).
//
// Run: node tests/publishing-analytics.smoketest.js

'use strict'

const assert = require('node:assert')
const A = require('../browser/publishing-analytics')

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n       ${err.message}`)
  }
}

// Two IG runs and one X run, at known UTC hours.
const records = [
  {
    meta: { actionId: 'ig_post', createdAt: '2026-06-20T09:00:00Z' },
    items: [
      { identityId: 'pedro', status: 'done', finishedAt: '2026-06-20T09:05:00Z' },
      { identityId: 'ctx', status: 'failed', finishedAt: '2026-06-20T09:06:00Z' },
      { identityId: 'inf', status: 'skipped', finishedAt: '2026-06-20T09:07:00Z' },
    ],
  },
  {
    meta: { actionId: 'ig_post', createdAt: '2026-06-20T14:00:00Z' },
    items: [
      { identityId: 'pedro', status: 'done', finishedAt: '2026-06-20T14:05:00Z' },
      { identityId: 'ctx', status: 'done', finishedAt: '2026-06-20T14:06:00Z' },
    ],
  },
  {
    meta: { actionId: 'x_post', createdAt: '2026-06-20T09:30:00Z' },
    items: [
      { identityId: 'pedro', status: 'failed', finishedAt: '2026-06-20T09:35:00Z' },
    ],
  },
  // A non-publish run that must be ignored.
  {
    meta: { actionId: 'ig_like', createdAt: '2026-06-20T10:00:00Z' },
    items: [{ identityId: 'pedro', status: 'done', finishedAt: '2026-06-20T10:05:00Z' }],
  },
]

ok('overall counts exclude non-publish actions', () => {
  const a = A.computeAnalytics(records)
  assert.strictEqual(a.overall.runs, 3) // 2 ig + 1 x, NOT ig_like
  assert.strictEqual(a.overall.items, 6)
  assert.strictEqual(a.overall.done, 3)
  assert.strictEqual(a.overall.failed, 2)
  assert.strictEqual(a.overall.skipped, 1)
  // successRate = done/(done+failed) = 3/5 = 0.6
  assert.strictEqual(a.overall.successRate, 0.6)
})

ok('byNetwork splits instagram vs x', () => {
  const a = A.computeAnalytics(records)
  assert.strictEqual(a.byNetwork.instagram.items, 5)
  assert.strictEqual(a.byNetwork.instagram.done, 3)
  assert.strictEqual(a.byNetwork.instagram.successRate, 0.75) // 3/(3+1)
  assert.strictEqual(a.byNetwork.x.failed, 1)
  assert.strictEqual(a.byNetwork.x.successRate, 0) // 0/(0+1)
})

ok('byIdentity aggregates across runs', () => {
  const a = A.computeAnalytics(records)
  // pedro: ig done, ig done, x failed → done2 failed1
  assert.strictEqual(a.byIdentity.pedro.done, 2)
  assert.strictEqual(a.byIdentity.pedro.failed, 1)
  assert.strictEqual(a.byIdentity.pedro.successRate, Math.round((2 / 3) * 1000) / 1000)
})

ok('byHour buckets by UTC hour, only non-empty', () => {
  const a = A.computeAnalytics(records)
  const h9 = a.byHour.find((h) => h.hour === 9)
  const h14 = a.byHour.find((h) => h.hour === 14)
  assert(h9 && h14)
  assert.strictEqual(h9.items, 4) // ig 3 + x 1 at 09:xx
  assert.strictEqual(h14.done, 2)
  assert(!a.byHour.some((h) => h.items === 0))
})

ok('bestHour picks the highest success rate', () => {
  const a = A.computeAnalytics(records)
  const best = A.bestHour(a)
  assert.strictEqual(best.hour, 14) // 100% vs 09 mixed
  assert.strictEqual(best.successRate, 1)
})

ok('empty / non-array input is safe', () => {
  const a = A.computeAnalytics(null)
  assert.strictEqual(a.overall.runs, 0)
  assert.strictEqual(a.overall.successRate, 0)
  assert.deepStrictEqual(a.byHour, [])
  assert.strictEqual(A.bestHour(a), null)
})

ok('actions filter overrides the default set', () => {
  const a = A.computeAnalytics(records, { actions: ['x_post'] })
  assert.strictEqual(a.overall.runs, 1)
  assert.strictEqual(a.byNetwork.x.failed, 1)
  assert.strictEqual(a.byNetwork.instagram, undefined)
})

console.log(`\npublishing-analytics: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
