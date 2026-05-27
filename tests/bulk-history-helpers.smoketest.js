// OZ Browser — bulk-history helpers smoke test (v2 Etapa 4.1).
//
// Run:
//   cd oz-browser
//   node tests/bulk-history-helpers.smoketest.js
//
// Covers (pure module — no Electron / DOM):
//   - filterRuns: status, actionId, identityId (with items hydration),
//     dateRange (7d/30d/all), search, combined filters, edge cases
//   - sortRuns: newest (default), oldest, status — stable order verified
//   - buildStats: total + per-status aggregation, missing meta tolerance
//   - buildFilterOptions: dedup, sort, identity inference from items[]

'use strict'

const path = require('path')

delete require.cache[require.resolve('../browser/ui/bulk-history-helpers.js')]
const h = require(path.join('..', 'browser', 'ui', 'bulk-history-helpers.js'))

let passed = 0
let failed = 0
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    passed++
  } else {
    failed++
    failures.push({ label, detail })
    console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
    return
  }
  console.log(`  ✓ ${label}`)
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(label, a === e, a === e ? '' : `got=${a} expected=${e}`)
}

function _meta(over = {}) {
  return {
    runId: 'r1',
    actionId: 'echo',
    actionLabel: 'Echo',
    status: 'completed',
    createdAt: '2026-05-20T10:00:00Z',
    finishedAt: '2026-05-20T10:00:05Z',
    identityCount: 2,
    stats: { done: 2, failed: 0, skipped: 0, cancelled: 0 },
    ...over,
  }
}

console.log('--- filterRuns ---')

const NOW = Date.parse('2026-05-25T12:00:00Z')

const sample = [
  {
    meta: _meta({
      runId: 'r1',
      status: 'completed',
      createdAt: '2026-05-25T08:00:00Z',
      actionId: 'echo',
      actionLabel: 'Echo',
    }),
  },
  {
    meta: _meta({
      runId: 'r2',
      status: 'failed',
      createdAt: '2026-05-24T08:00:00Z',
      actionId: 'ig_like',
      actionLabel: 'IG Like',
    }),
  },
  {
    meta: _meta({
      runId: 'r3',
      status: 'completed',
      createdAt: '2026-05-10T08:00:00Z',
      actionId: 'ig_like',
      actionLabel: 'IG Like',
    }),
  },
  {
    meta: _meta({
      runId: 'r4',
      status: 'cancelled',
      createdAt: '2026-04-01T08:00:00Z',
      actionId: 'echo',
      actionLabel: 'Echo',
    }),
  },
  {
    meta: _meta({
      runId: 'r5',
      status: 'running',
      createdAt: '2026-05-25T11:00:00Z',
      actionId: 'x_post',
      actionLabel: 'X Post',
    }),
  },
]

// Pass-through (no filters).
eq(
  'no filters returns all rows',
  h.filterRuns(sample, { nowMs: NOW }).map((r) => r.meta.runId),
  ['r1', 'r2', 'r3', 'r4', 'r5'],
)

// Status filter.
eq(
  'status=failed returns only failed runs',
  h.filterRuns(sample, { status: 'failed', nowMs: NOW }).map((r) => r.meta.runId),
  ['r2'],
)
eq(
  'status=completed returns only completed runs',
  h.filterRuns(sample, { status: 'completed', nowMs: NOW }).map((r) => r.meta.runId),
  ['r1', 'r3'],
)

// Action filter.
eq(
  'actionId=ig_like returns only IG Like runs',
  h.filterRuns(sample, { actionId: 'ig_like', nowMs: NOW }).map((r) => r.meta.runId),
  ['r2', 'r3'],
)

// Date range — 7d cutoff at 2026-05-18.
eq(
  'dateRange=7d excludes runs older than 7 days',
  h.filterRuns(sample, { dateRange: '7d', nowMs: NOW }).map((r) => r.meta.runId),
  ['r1', 'r2', 'r5'],
)
eq(
  'dateRange=30d includes runs within 30 days',
  h.filterRuns(sample, { dateRange: '30d', nowMs: NOW }).map((r) => r.meta.runId),
  ['r1', 'r2', 'r3', 'r5'],
)
eq(
  'dateRange=all returns everything',
  h.filterRuns(sample, { dateRange: 'all', nowMs: NOW }).map((r) => r.meta.runId),
  ['r1', 'r2', 'r3', 'r4', 'r5'],
)

// Search filter — case-insensitive substring on runId/actionId/actionLabel.
eq(
  'search=IG matches actionLabel "IG Like"',
  h.filterRuns(sample, { search: 'IG', nowMs: NOW }).map((r) => r.meta.runId),
  ['r2', 'r3'],
)
eq(
  'search=r5 matches runId',
  h.filterRuns(sample, { search: 'r5', nowMs: NOW }).map((r) => r.meta.runId),
  ['r5'],
)
eq(
  'search returns empty when nothing matches',
  h.filterRuns(sample, { search: 'nonexistent', nowMs: NOW }).map((r) => r.meta.runId),
  [],
)

// Identity filter — requires items hydrated.
const withItems = [
  {
    meta: _meta({ runId: 'r1', identityCount: 2 }),
    items: [
      { identityId: 'idA', identityName: 'Alice', status: 'done' },
      { identityId: 'idB', identityName: 'Bob', status: 'done' },
    ],
  },
  {
    meta: _meta({ runId: 'r2', identityCount: 1 }),
    items: [{ identityId: 'idC', identityName: 'Carol', status: 'failed' }],
  },
  { meta: _meta({ runId: 'r3', identityCount: 1 }), items: null }, // unhydrated
]
eq(
  'identityId=idA matches r1 (has items)',
  h.filterRuns(withItems, { identityId: 'idA', nowMs: NOW }).map((r) => r.meta.runId),
  ['r1'],
)
eq(
  'identityId=idC matches r2',
  h.filterRuns(withItems, { identityId: 'idC', nowMs: NOW }).map((r) => r.meta.runId),
  ['r2'],
)
eq(
  'identityId on unhydrated row (items=null) is excluded',
  h
    .filterRuns(withItems, { identityId: 'idA', nowMs: NOW })
    .every((r) => r.items != null),
  true,
)

// Combined filters AND-chain.
eq(
  'status=completed + actionId=ig_like + dateRange=30d → only r3',
  h
    .filterRuns(sample, {
      status: 'completed',
      actionId: 'ig_like',
      dateRange: '30d',
      nowMs: NOW,
    })
    .map((r) => r.meta.runId),
  ['r3'],
)

// Edge cases.
eq('empty input returns empty array', h.filterRuns([], { nowMs: NOW }), [])
eq('null input returns empty array', h.filterRuns(null, { nowMs: NOW }), [])
eq(
  'row without meta key still works (raw meta)',
  h
    .filterRuns([_meta({ runId: 'raw' })], { nowMs: NOW })
    .map((r) => r.runId || r.meta?.runId),
  ['raw'],
)

console.log('\n--- sortRuns ---')

eq(
  'sort=newest (default) by createdAt desc',
  h.sortRuns(sample).map((r) => r.meta.runId),
  ['r5', 'r1', 'r2', 'r3', 'r4'],
)
eq(
  'sort=oldest by createdAt asc',
  h.sortRuns(sample, 'oldest').map((r) => r.meta.runId),
  ['r4', 'r3', 'r2', 'r1', 'r5'],
)
// status order: failed < running/cancelling < cancelled < completed < created
// within status: newest first
eq(
  'sort=status puts failed first, then running, then cancelled, then completed',
  h.sortRuns(sample, 'status').map((r) => r.meta.runId),
  ['r2', 'r5', 'r4', 'r1', 'r3'],
)

eq('empty input returns empty', h.sortRuns([]), [])
eq('null input returns empty', h.sortRuns(null), [])

console.log('\n--- buildStats ---')

const stats = h.buildStats(sample)
eq('total counts all rows', stats.total, 5)
eq('completed count', stats.completed, 2)
eq('failed count', stats.failed, 1)
eq('cancelled count', stats.cancelled, 1)
eq('running count (includes cancelling)', stats.running, 1)

// Add a cancelling row to confirm it falls in 'running' bucket.
const withCancelling = [...sample, { meta: _meta({ runId: 'r6', status: 'cancelling' }) }]
eq('cancelling status counted as running', h.buildStats(withCancelling).running, 2)

// Missing meta tolerance.
const dirty = [{}, null, { meta: null }, { meta: _meta({ status: 'completed' }) }]
const dirtyStats = h.buildStats(dirty)
eq('buildStats tolerates null/empty entries', dirtyStats.total, 1)
eq('buildStats counts the valid completed entry', dirtyStats.completed, 1)

console.log('\n--- buildFilterOptions ---')

const pool = [
  {
    meta: _meta({ actionId: 'echo', actionLabel: 'Echo' }),
    items: [{ identityId: 'idA', identityName: 'Alice' }],
  },
  {
    meta: _meta({ actionId: 'ig_like', actionLabel: 'IG Like' }),
    items: [
      { identityId: 'idA', identityName: 'Alice' },
      { identityId: 'idB', identityName: 'Bob' },
    ],
  },
  {
    meta: _meta({ actionId: 'echo', actionLabel: 'Echo' }), // duplicate action
    items: [{ identityId: 'idC', identityName: 'Carol' }],
  },
]
const opts = h.buildFilterOptions(pool)
eq(
  'actions deduped + alpha-sorted by label',
  opts.actions.map((a) => a.id),
  ['echo', 'ig_like'],
)
eq(
  'identities deduped + alpha-sorted by name',
  opts.identities.map((i) => i.id),
  ['idA', 'idB', 'idC'],
)
eq('empty pool returns empty options', h.buildFilterOptions([]).actions, [])

// Identities only populated when items present.
const noItems = [{ meta: _meta({ actionId: 'echo' }) }]
eq('no items → no identities in options', h.buildFilterOptions(noItems).identities, [])

console.log(`\n${passed} passed · ${failed} failed`)
if (failed > 0) {
  console.error('FAILURES:')
  for (const f of failures) {
    console.error(`  - ${f.label}${f.detail ? ': ' + f.detail : ''}`)
  }
  process.exit(1)
}
