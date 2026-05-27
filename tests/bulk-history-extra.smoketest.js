// OZ Browser — bulk-history retry + CSV helpers smoke test (v2 Etapa 4.3 + 4.5).
//
// Split from bulk-history-helpers.smoketest.js to keep each file under the
// 500 LOC budget (ADR 0005). The 4.1 helpers (filterRuns / sortRuns /
// buildStats / buildFilterOptions) live in the sibling smoketest.
//
// Covers (pure module — no Electron / DOM):
//   - 4.3 retry: getRetryableIdentityIds, getFailedIdentityIds,
//                buildRetrySpec, canRetryRun
//   - 4.5 CSV:   toCsvCell (RFC 4180), runsToCSV, runDetailToCSV

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

// ─── Retry helpers (v2 Etapa 4.3) ───────────────────────────────────

console.log('--- getRetryableIdentityIds ---')

const mixedRun = {
  meta: _meta({ runId: 'rmix', status: 'completed' }),
  items: [
    { identityId: 'idA', identityName: 'Alice', status: 'done' },
    { identityId: 'idB', identityName: 'Bob', status: 'failed' },
    { identityId: 'idC', identityName: 'Carol', status: 'cancelled' },
    { identityId: 'idD', identityName: 'Dave', status: 'skipped' },
    { identityId: 'idE', identityName: 'Eve', status: 'pending' },
  ],
}
eq(
  'getRetryableIdentityIds returns failed + cancelled, not done/skipped/pending',
  h.getRetryableIdentityIds(mixedRun),
  ['idB', 'idC'],
)
eq(
  'getRetryableIdentityIds returns [] when items absent',
  h.getRetryableIdentityIds({ meta: _meta({}) }),
  [],
)
eq('getRetryableIdentityIds handles null run', h.getRetryableIdentityIds(null), [])
eq(
  'getRetryableIdentityIds skips items without identityId',
  h.getRetryableIdentityIds({
    items: [{ status: 'failed' }, { identityId: 'x', status: 'failed' }],
  }),
  ['x'],
)

console.log('\n--- getFailedIdentityIds ---')

eq(
  'getFailedIdentityIds is subset (failed only, NOT cancelled)',
  h.getFailedIdentityIds(mixedRun),
  ['idB'],
)
eq(
  'getFailedIdentityIds returns [] for all-cancelled run',
  h.getFailedIdentityIds({
    items: [
      { identityId: 'a', status: 'cancelled' },
      { identityId: 'b', status: 'cancelled' },
    ],
  }),
  [],
)
eq('getFailedIdentityIds handles null', h.getFailedIdentityIds(null), [])

console.log('\n--- buildRetrySpec ---')

const origMeta = _meta({
  actionId: 'ig_like',
  params: { url: 'https://instagram.com/p/X' },
  options: { minDelayMs: 5000, maxDelayMs: 60000 },
})
const spec = h.buildRetrySpec(origMeta, ['id1', 'id2'])
eq('buildRetrySpec actionId copied', spec.actionId, 'ig_like')
eq('buildRetrySpec identityIds copied', spec.identityIds, ['id1', 'id2'])
eq('buildRetrySpec params copied', spec.params, { url: 'https://instagram.com/p/X' })
eq('buildRetrySpec options copied', spec.options, { minDelayMs: 5000, maxDelayMs: 60000 })

// Mutation safety.
const inputIds = ['a', 'b']
const sp = h.buildRetrySpec(origMeta, inputIds)
sp.identityIds.push('c')
eq('buildRetrySpec defensively copies identityIds (input untouched)', inputIds, [
  'a',
  'b',
])
const inputParams = { url: 'x' }
const sp2 = h.buildRetrySpec(_meta({ params: inputParams }), ['x'])
sp2.params.url = 'changed'
eq('buildRetrySpec defensively copies params (input untouched)', inputParams.url, 'x')

// Defensive defaults.
const minMeta = { actionId: 'echo' }
const sp3 = h.buildRetrySpec(minMeta, ['x'])
eq('buildRetrySpec params defaults to {} when meta.params missing', sp3.params, {})
eq('buildRetrySpec options defaults to {} when meta.options missing', sp3.options, {})

// Error paths.
let threw = false
try {
  h.buildRetrySpec(null, ['x'])
} catch (e) {
  threw = /meta required/.test(e.message)
}
ok('buildRetrySpec throws when meta missing', threw)

threw = false
try {
  h.buildRetrySpec(origMeta, [])
} catch (e) {
  threw = /non-empty identityIds/.test(e.message)
}
ok('buildRetrySpec throws on empty identityIds', threw)

threw = false
try {
  h.buildRetrySpec(origMeta, null)
} catch (e) {
  threw = /non-empty identityIds/.test(e.message)
}
ok('buildRetrySpec throws on null identityIds', threw)

console.log('\n--- canRetryRun ---')

ok(
  'canRetryRun true for terminal completed run with failed item',
  h.canRetryRun(mixedRun) === true,
)
ok(
  'canRetryRun false for still-running run (not terminal)',
  h.canRetryRun({
    meta: _meta({ status: 'running' }),
    items: [{ identityId: 'x', status: 'failed' }],
  }) === false,
)
ok(
  'canRetryRun false for cancelling run (not terminal)',
  h.canRetryRun({
    meta: _meta({ status: 'cancelling' }),
    items: [{ identityId: 'x', status: 'failed' }],
  }) === false,
)
ok(
  'canRetryRun false for run with no retryable items',
  h.canRetryRun({
    meta: _meta({ status: 'completed' }),
    items: [{ identityId: 'x', status: 'done' }],
  }) === false,
)
ok(
  'canRetryRun true for terminal-failed run with retryable items',
  h.canRetryRun({
    meta: _meta({ status: 'failed' }),
    items: [{ identityId: 'x', status: 'failed' }],
  }) === true,
)
ok('canRetryRun false for null', h.canRetryRun(null) === false)
ok('canRetryRun false for missing items', h.canRetryRun({ meta: _meta({}) }) === false)

// ─── CSV export helpers (v2 Etapa 4.5) ──────────────────────────────

console.log('\n--- toCsvCell ---')

eq('null becomes empty', h.toCsvCell(null), '')
eq('undefined becomes empty', h.toCsvCell(undefined), '')
eq('empty string is empty', h.toCsvCell(''), '')
eq('plain string passes through', h.toCsvCell('hello'), 'hello')
eq('numbers stringified', h.toCsvCell(42), '42')
eq('zero stringified', h.toCsvCell(0), '0')
eq('boolean stringified', h.toCsvCell(true), 'true')
eq('comma triggers quoting', h.toCsvCell('a,b'), '"a,b"')
eq('quote triggers quoting + doubling', h.toCsvCell('a"b'), '"a""b"')
eq('newline triggers quoting', h.toCsvCell('a\nb'), '"a\nb"')
eq('CR triggers quoting', h.toCsvCell('a\rb'), '"a\rb"')
eq('multiple specials all quoted', h.toCsvCell('a,b"c'), '"a,b""c"')
eq('object JSON-stringified + escaped', h.toCsvCell({ k: 'v' }), '"{""k"":""v""}"')
eq(
  'object with quote in JSON gets escaped',
  h.toCsvCell({ msg: 'hi "world"' }),
  '"{""msg"":""hi \\""world\\""""}"',
)

console.log('\n--- runsToCSV ---')

const csvRows = [
  {
    meta: _meta({
      runId: 'rA',
      actionId: 'ig_like',
      actionLabel: 'IG Like',
      createdAt: '2026-05-20T10:00:00Z',
      finishedAt: '2026-05-20T10:05:00Z',
      status: 'completed',
      identityCount: 3,
      stats: { done: 2, failed: 1, skipped: 0, cancelled: 0 },
    }),
  },
  {
    meta: _meta({
      runId: 'rB',
      actionId: 'echo',
      actionLabel: 'Echo, comma test',
      createdAt: '2026-05-19T08:00:00Z',
      status: 'failed',
      identityCount: 1,
      stats: { done: 0, failed: 1, skipped: 0, cancelled: 0 },
    }),
  },
]

const runsCsv = h.runsToCSV(csvRows)
const runsLines = runsCsv.split('\r\n').filter((l) => l.length > 0)
eq('runsToCSV has header + 2 data rows', runsLines.length, 3)
eq(
  'runsToCSV header is canonical',
  runsLines[0],
  'createdAt,runId,actionId,actionLabel,identityCount,status,done,failed,skipped,cancelled,finishedAt',
)
ok('runsToCSV escapes commas in actionLabel', runsLines[2].includes('"Echo, comma test"'))
ok('runsToCSV row 1 contains expected runId', runsLines[1].includes('rA'))
ok('runsToCSV row 1 contains expected status', runsLines[1].includes('completed'))
ok('runsToCSV terminates with CRLF', /\r\n$/.test(runsCsv))

eq(
  'runsToCSV([]) yields only header',
  h
    .runsToCSV([])
    .split('\r\n')
    .filter((l) => l).length,
  1,
)
eq(
  'runsToCSV(null) yields only header',
  h
    .runsToCSV(null)
    .split('\r\n')
    .filter((l) => l).length,
  1,
)
eq(
  'runsToCSV skips invalid entries',
  h
    .runsToCSV([{}, null, csvRows[0], { meta: null }])
    .split('\r\n')
    .filter((l) => l).length,
  2,
)

console.log('\n--- runDetailToCSV ---')

const detailRun = {
  meta: _meta({ runId: 'rD', actionId: 'ig_like' }),
  items: [
    {
      identityId: 'idA',
      identityName: 'Alice',
      status: 'done',
      result: { likedPostId: 'X' },
      startedAt: '2026-05-20T10:00:00Z',
      finishedAt: '2026-05-20T10:00:05Z',
    },
    {
      identityId: 'idB',
      identityName: 'Bob, esq.',
      status: 'failed',
      error: { code: 'NOT_FOUND', message: 'Selector "div.like" not found' },
      startedAt: '2026-05-20T10:01:00Z',
      finishedAt: '2026-05-20T10:01:03Z',
    },
  ],
}
const detailCsv = h.runDetailToCSV(detailRun)
const detailLines = detailCsv.split('\r\n').filter((l) => l.length > 0)
eq('runDetailToCSV has header + 2 data rows', detailLines.length, 3)
eq(
  'runDetailToCSV header is canonical',
  detailLines[0],
  'runId,identityId,identityName,status,result,errorCode,errorMessage,startedAt,finishedAt',
)
ok('runDetailToCSV escapes comma in identityName', detailLines[2].includes('"Bob, esq."'))
ok('runDetailToCSV row 1 has runId', detailLines[1].includes('rD'))
ok(
  'runDetailToCSV serializes result object as JSON',
  detailLines[1].includes('likedPostId'),
)
ok('runDetailToCSV row 2 has error code', detailLines[2].includes('NOT_FOUND'))
ok(
  'runDetailToCSV row 2 quotes error message with quotes',
  detailLines[2].includes('Selector ""div.like"" not found'),
)

eq(
  'runDetailToCSV(null) yields only header',
  h
    .runDetailToCSV(null)
    .split('\r\n')
    .filter((l) => l).length,
  1,
)
eq(
  'runDetailToCSV(run with no items) yields only header',
  h
    .runDetailToCSV({ meta: _meta({}), items: [] })
    .split('\r\n')
    .filter((l) => l).length,
  1,
)

console.log(`\n${passed} passed · ${failed} failed`)
if (failed > 0) {
  console.error('FAILURES:')
  for (const f of failures) {
    console.error(`  - ${f.label}${f.detail ? ': ' + f.detail : ''}`)
  }
  process.exit(1)
}
