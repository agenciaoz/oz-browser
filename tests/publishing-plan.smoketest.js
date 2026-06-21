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

// ---- publish mapping (platform → bulk action + params) ---------------------

ok('platformToActionId + buildPublishParams', () => {
  assert.strictEqual(P.platformToActionId('instagram'), 'ig_post')
  assert.strictEqual(P.platformToActionId('x'), 'x_post')
  assert.strictEqual(P.platformToActionId('facebook'), 'fb_post')
  assert.strictEqual(P.platformToActionId('tiktok'), null)
  assert.deepStrictEqual(
    P.buildPublishParams('instagram', { media: ['/p.jpg'], caption: 'hi' }),
    { imagePath: '/p.jpg', caption: 'hi' },
  )
  assert.deepStrictEqual(P.buildPublishParams('x', { caption: 'tweet' }), {
    text: 'tweet',
  })
  assert.deepStrictEqual(P.buildPublishParams('instagram', {}), {
    imagePath: '',
    caption: '',
  })
})

// ---- buildBulkSpec (pure validation + spec) --------------------------------

ok('buildBulkSpec: valid IG → spec; missing pieces → __error', () => {
  const good = P.buildBulkSpec({
    platform: 'instagram',
    caption: 'hi',
    media: ['/p.jpg'],
    identities: ['p1', 'p2'],
  })
  assert.deepStrictEqual(good.spec, {
    actionId: 'ig_post',
    identityIds: ['p1', 'p2'],
    params: { imagePath: '/p.jpg', caption: 'hi' },
  })
  assert.strictEqual(
    P.buildBulkSpec({ platform: 'tiktok', identities: ['p1'] }).__error.code,
    'UNSUPPORTED_PLATFORM',
  )
  assert.strictEqual(
    P.buildBulkSpec({ platform: 'x', caption: 'hi', identities: [] }).__error.code,
    'NO_TARGETS',
  )
  assert.strictEqual(
    P.buildBulkSpec({ platform: 'instagram', caption: 'hi', identities: ['p1'] }).__error
      .code,
    'NO_MEDIA',
  )
})

// ---- schedule / unschedule handlers (fake bulk + scheduled deps) -----------

ok('handlers.schedule: creates a bulk Scheduled Action + stores its id', () => {
  const dir = tmpDir()
  const created = []
  const removed = []
  const browser = {
    handlers: {
      bulk: { run: async () => ({ ok: true, runId: 'r1' }) },
      scheduled: {
        create: (input) => {
          created.push(input)
          return { ok: true, action: { id: 'sa-1', ...input } }
        },
        remove: (id) => {
          removed.push(id)
          return { ok: true, removed: true }
        },
      },
    },
  }
  // build handlers against a real store in tmp dir
  process.env.OZ_TEST_USERDATA = dir
  delete require.cache[require.resolve('../browser/publishing-plan-handlers.js')]
  // electron.app.getPath is stubbed below via module mock
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => dir } }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  const { buildPublishingHandlers } = require('../browser/publishing-plan-handlers.js')
  const h = buildPublishingHandlers(browser)
  Module._load = origLoad

  const pub = h.import({
    rows: [{ platform: 'x', caption: 'hi', identities: 'p1' }],
  })
  assert.strictEqual(pub.added, 1)
  const id = h.list()[0].id

  const res = h.schedule(id, { type: 'daily', time: '09:00' })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(created.length, 1)
  assert.strictEqual(created[0].action, 'bulk')
  assert.deepStrictEqual(created[0].params.spec.identityIds, ['p1'])
  assert.strictEqual(h.get(id).scheduledActionId, 'sa-1')

  const un = h.unschedule(id)
  assert.strictEqual(un.removed, true)
  assert.deepStrictEqual(removed, ['sa-1'])
  assert.strictEqual(h.get(id).scheduledActionId, null)

  // scheduleCompose: schedule from RAW composer input (no plan store id).
  const before = created.length
  const sc = h.scheduleCompose({
    platform: 'x',
    identityIds: ['p1', 'p2'],
    params: { text: 'hola' },
    schedule: { type: 'daily', time: '08:00' },
    name: 'manual',
  })
  assert.strictEqual(sc.ok, true)
  assert.strictEqual(created.length, before + 1)
  const last = created[created.length - 1]
  assert.strictEqual(last.action, 'bulk')
  assert.strictEqual(last.params.spec.actionId, 'x_post')
  assert.deepStrictEqual(last.params.spec.identityIds, ['p1', 'p2'])
  // unknown platform short-circuits with __error (scheduler untouched)
  const bad = h.scheduleCompose({ platform: 'myspace', schedule: {} })
  assert.strictEqual(bad.__error.code, 'UNSUPPORTED_PLATFORM')

  // unsupported platform short-circuits before touching the scheduler
  const fb = h.import({ rows: [{ platform: 'ig', caption: 'x', media: '' }] })
  void fb
  fs.rmSync(dir, { recursive: true, force: true })
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

// ── Dry-run / pre-flight (Etapa 2) ─────────────────────────────────────
ok('dryRunReport: ok when platform/media/identities all valid', () => {
  const r = P.dryRunReport(
    { id: 'p1', platform: 'instagram', media: ['/tmp/a.jpg'], identities: ['i1', 'i2'] },
    {
      identitiesById: { i1: { name: 'Pedro' }, i2: { name: 'Ctx' } },
      healthById: { i1: 'green', i2: 'yellow' },
      mediaExists: () => true,
    },
  )
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.actionId, 'ig_post')
  assert.strictEqual(r.issues.length, 0)
  assert.strictEqual(r.identities.length, 2)
  assert.strictEqual(r.identities[0].name, 'Pedro')
  assert.strictEqual(
    r.identities.every((i) => i.willPublish),
    true,
  )
})

ok('dryRunReport: flags missing media file on disk', () => {
  const r = P.dryRunReport(
    { id: 'p2', platform: 'instagram', media: ['/tmp/missing.jpg'], identities: ['i1'] },
    {
      identitiesById: { i1: { name: 'P' } },
      healthById: { i1: 'green' },
      mediaExists: () => false,
    },
  )
  assert.strictEqual(r.ok, false)
  assert(r.issues.some((i) => i.code === 'MEDIA_NOT_FOUND'))
})

ok('dryRunReport: red identity is not willPublish and blocks ok', () => {
  const r = P.dryRunReport(
    { id: 'p3', platform: 'x', caption: 'hi', identities: ['i1', 'i2'] },
    {
      identitiesById: { i1: { name: 'A' }, i2: { name: 'B' } },
      healthById: { i1: 'green', i2: 'red' },
    },
  )
  assert.strictEqual(r.ok, false)
  const b = r.identities.find((i) => i.identityId === 'i2')
  assert.strictEqual(b.willPublish, false)
})

ok('dryRunReport: unknown identity flagged exists=false', () => {
  const r = P.dryRunReport(
    { id: 'p4', platform: 'x', caption: 'hi', identities: ['ghost'] },
    { identitiesById: {}, healthById: {} },
  )
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.identities[0].exists, false)
})

ok('dryRunReport: unsupported platform short-circuits', () => {
  const r = P.dryRunReport({ id: 'p5', platform: 'tiktok', identities: ['i1'] }, {})
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.issues[0].code, 'UNSUPPORTED_PLATFORM')
})

ok('facebook maps to fb_post (text, no media required)', () => {
  assert.strictEqual(P.platformToActionId('facebook'), 'fb_post')
  assert.strictEqual(P.platformToActionId(P.normalizePlatform('fb')), 'fb_post')
  const params = P.buildPublishParams('facebook', { caption: 'hola' })
  assert.strictEqual(params.text, 'hola')
  const built = P.buildBulkSpec({
    platform: 'facebook',
    caption: 'hi',
    identities: ['i1'],
  })
  assert.strictEqual(built.spec.actionId, 'fb_post')
  const r = P.dryRunReport(
    { id: 'pf', platform: 'facebook', caption: 'hi', identities: ['i1'] },
    { identitiesById: { i1: { name: 'P' } }, healthById: { i1: 'green' } },
  )
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.actionId, 'fb_post')
})

console.log(`\n✓ publishing-plan + store (E5): ${passed} checks passed`)
