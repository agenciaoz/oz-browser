// OZ Browser — Publishing Studio E5 data layer smoke test.
//
// Run: node tests/publishing-plan.smoketest.js
//
// Covers publishing-plan.js (pure) + the publications collection in
// publishing-store.js (injectable in-memory storage).

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

delete require.cache[require.resolve('../browser/ui/publishing-plan.js')]
delete require.cache[require.resolve('../browser/publishing-plan-store.js')]
const P = require(path.join('..', 'browser', 'ui', 'publishing-plan.js'))
const { PublishingPlanStore } = require(
  path.join('..', 'browser', 'publishing-plan-store.js'),
)

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log('  ✓ ' + name)
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oz-pubplan-'))
}

console.log('publishing-plan + store (E5) smoke test')

// ---- matrixToPlanRows -------------------------------------------------------

ok('matrixToPlanRows: maps headers (alias) + skips empty rows', () => {
  const matrix = [
    ['Fecha', 'Red', 'Caption', 'Media', 'Cuentas'],
    ['2026-07-01', 'IG', 'Hola', 'a.jpg', 'pedro, contexto'],
    ['', '', '', '', ''],
    ['2026-07-02', 'x', 'Tweet', '', 'pedro'],
  ]
  const rows = P.matrixToPlanRows(matrix)
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].date, '2026-07-01')
  assert.strictEqual(rows[0].platform, 'IG')
  assert.strictEqual(rows[0].caption, 'Hola')
})

// ---- parsePlanRows ----------------------------------------------------------

ok('parsePlanRows: normalizes platform + splits lists', () => {
  const { publications, errors } = P.parsePlanRows([
    {
      date: '2026-07-01',
      platform: 'IG',
      caption: 'Hola',
      media: 'a.jpg; b.jpg',
      identities: 'p1, p2',
    },
  ])
  assert.strictEqual(errors.length, 0)
  assert.strictEqual(publications.length, 1)
  assert.strictEqual(publications[0].platform, 'instagram')
  assert.deepStrictEqual(publications[0].media, ['a.jpg', 'b.jpg'])
  assert.deepStrictEqual(publications[0].identities, ['p1', 'p2'])
  assert.strictEqual(publications[0].status, 'draft')
  assert.strictEqual(publications[0].scheduledAt, '2026-07-01')
})

ok('parsePlanRows: flags bad platform + missing caption/media', () => {
  const { publications, errors } = P.parsePlanRows([
    { platform: 'myspace', caption: 'x' },
    { platform: 'ig' }, // no caption, no media
    { platform: 'x', caption: 'ok' },
  ])
  assert.strictEqual(publications.length, 1)
  assert.strictEqual(errors.length, 2)
})

// ---- approval state machine -------------------------------------------------

ok('approval transitions: draft→review→approved→published', () => {
  assert.strictEqual(P.nextStatus('draft', 'submit'), 'review')
  assert.strictEqual(P.nextStatus('review', 'approve'), 'approved')
  assert.strictEqual(P.nextStatus('approved', 'publish'), 'published')
  assert.strictEqual(P.nextStatus('review', 'reject'), 'draft')
  assert.strictEqual(P.nextStatus('approved', 'edit'), 'draft')
})

ok('canTransition: rejects invalid moves', () => {
  assert.strictEqual(P.canTransition('draft', 'approve'), false)
  assert.strictEqual(P.canTransition('published', 'publish'), false)
  assert.strictEqual(P.canTransition('draft', 'submit'), true)
  // no-op nextStatus stays put
  assert.strictEqual(P.nextStatus('draft', 'approve'), 'draft')
})

// ---- planToMatrix (export) --------------------------------------------------

ok('planToMatrix: round-trips through parse', () => {
  const matrix = P.planToMatrix([
    {
      scheduledAt: '2026-07-01',
      platform: 'instagram',
      caption: 'Hi',
      media: ['a.jpg'],
      identities: ['p1'],
      status: 'approved',
    },
  ])
  assert.deepStrictEqual(matrix[0], [
    'date',
    'platform',
    'caption',
    'media',
    'identities',
    'status',
  ])
  assert.strictEqual(matrix[1][1], 'instagram')
  assert.strictEqual(matrix[1][5], 'approved')
})

// ---- main store: publications + persistence --------------------------------

ok('PublishingPlanStore: bulk add + list + status + persist', () => {
  const dir = tmpDir()
  const s = new PublishingPlanStore({ userDataDir: dir })
  const { publications } = P.parsePlanRows([
    { date: '2026-07-01', platform: 'ig', caption: 'A' },
    { date: '2026-07-02', platform: 'x', caption: 'B' },
  ])
  assert.strictEqual(s.addMany(publications), 2)
  assert.strictEqual(s.list().length, 2)
  assert.strictEqual(s.listByStatus('draft').length, 2)

  const first = s.list()[0]
  s.setStatus(first.id, 'review')
  assert.strictEqual(s.listByStatus('review').length, 1)
  assert.strictEqual(s.setStatus(first.id, 'bogus'), null)
  s.update(first.id, { caption: 'edited' })
  assert.strictEqual(s.get(first.id).caption, 'edited')

  // persists across instances
  const s2 = new PublishingPlanStore({ userDataDir: dir })
  assert.strictEqual(s2.list().length, 2)
  assert.strictEqual(s2.remove(first.id), true)
  assert.strictEqual(s2.list().length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n✓ publishing-plan + store (E5): ${passed} checks passed`)
