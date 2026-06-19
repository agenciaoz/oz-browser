// OZ Browser — Publishing Studio pure helpers smoke test (v2 Etapa 1).
//
// Runs under `node tests/publishing-helpers.smoketest.js` (no framework),
// same convention as the other *.smoketest.js files.

'use strict'

const assert = require('node:assert')
const H = require('../browser/ui/publishing-helpers')

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
function section(title) {
  console.log(`\n# ${title}`)
}

// Fixtures mirroring the real bulk registry shapes.
const igAction = {
  id: 'ig_post',
  label: 'Instagram: Post an image',
  paramsSchema: {
    type: 'object',
    properties: {
      imagePath: { type: 'string' },
      caption: { type: 'string', maxLength: 2200 },
      timeoutMs: { type: 'number' },
    },
    required: ['imagePath'],
  },
}
const xAction = {
  id: 'x_post',
  label: 'X (Twitter): Post a tweet',
  paramsSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 280 },
      timeoutMs: { type: 'number' },
    },
    required: ['text'],
  },
}
const likeAction = { id: 'ig_like', label: 'Instagram: Like', paramsSchema: {} }

section('pickPublishActions')
ok('keeps only publishable actions, drops likes', () => {
  const picked = H.pickPublishActions([likeAction, xAction, igAction])
  assert.deepStrictEqual(
    picked.map((p) => p.actionId),
    ['ig_post', 'x_post'],
  )
  assert.strictEqual(picked[0].platform, 'instagram')
  assert.strictEqual(picked[1].platform, 'x')
})
ok('tolerates garbage input', () => {
  assert.deepStrictEqual(H.pickPublishActions(null), [])
  assert.deepStrictEqual(H.pickPublishActions([null, 42, {}]), [])
})

section('fieldsFromSchema')
ok('IG exposes imagePath (image, required) + caption (textarea), hides timeoutMs', () => {
  const fields = H.fieldsFromSchema(igAction)
  const names = fields.map((f) => f.name)
  assert.deepStrictEqual(names, ['imagePath', 'caption'])
  assert.strictEqual(fields[0].control, 'image')
  assert.strictEqual(fields[0].required, true)
  assert.strictEqual(fields[1].control, 'textarea')
  assert.strictEqual(fields[1].required, false)
  assert.strictEqual(fields[1].maxLength, 2200)
})
ok('X exposes text (textarea, required, max 280)', () => {
  const fields = H.fieldsFromSchema(xAction)
  assert.deepStrictEqual(
    fields.map((f) => f.name),
    ['text'],
  )
  assert.strictEqual(fields[0].maxLength, 280)
  assert.strictEqual(fields[0].required, true)
})

section('coercePublishParams')
ok('drops empty optional, trims, keeps required', () => {
  const fields = H.fieldsFromSchema(igAction)
  const params = H.coercePublishParams(fields, {
    imagePath: '  /tmp/a.jpg ',
    caption: '   ',
  })
  assert.deepStrictEqual(params, { imagePath: '/tmp/a.jpg' })
})

section('validatePublishInput')
ok('flags missing required', () => {
  const fields = H.fieldsFromSchema(xAction)
  const v = H.validatePublishInput(fields, {})
  assert.strictEqual(v.ok, false)
  assert.strictEqual(v.errors[0].field, 'text')
  assert.strictEqual(v.errors[0].code, 'required')
})
ok('flags too long', () => {
  const fields = H.fieldsFromSchema(xAction)
  const v = H.validatePublishInput(fields, { text: 'x'.repeat(281) })
  assert.strictEqual(v.ok, false)
  assert.strictEqual(v.errors[0].code, 'tooLong')
})
ok('passes a valid post', () => {
  const fields = H.fieldsFromSchema(xAction)
  const v = H.validatePublishInput(fields, { text: 'hola mundo' })
  assert.strictEqual(v.ok, true)
})

section('health partitioning')
ok('normalizeHealthMap handles array and map shapes', () => {
  const m = H.normalizeHealthMap([
    { identityId: 'a', overall: 'green' },
    { id: 'b', status: 'red' },
  ])
  assert.strictEqual(m.get('a'), 'green')
  assert.strictEqual(m.get('b'), 'red')
})
ok('partitions allowed/warned/blocked by health', () => {
  const health = [
    { identityId: 'a', overall: 'green' },
    { identityId: 'b', overall: 'yellow' },
    { identityId: 'c', overall: 'red' },
  ]
  const r = H.partitionTargetsByHealth(['a', 'b', 'c', 'd'], health)
  assert.deepStrictEqual(r.allowed, ['a', 'b', 'd']) // d unknown => allowed
  assert.deepStrictEqual(
    r.warned.map((w) => w.id),
    ['b'],
  )
  assert.deepStrictEqual(
    r.blocked.map((x) => x.id),
    ['c'],
  )
})

section('buildPublishSpec + preflight')
ok('buildPublishSpec produces the bulk create shape', () => {
  const spec = H.buildPublishSpec({
    actionId: 'ig_post',
    identityIds: ['a', 'b'],
    params: { imagePath: '/x.jpg' },
  })
  assert.deepStrictEqual(spec, {
    actionId: 'ig_post',
    identityIds: ['a', 'b'],
    params: { imagePath: '/x.jpg' },
  })
})
ok('preflight rejects no targets', () => {
  const fields = H.fieldsFromSchema(xAction)
  const r = H.preflightPublish({
    fields,
    params: { text: 'hi' },
    identityIds: [],
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'noTargets')
})
ok('preflight rejects too many targets', () => {
  const fields = H.fieldsFromSchema(xAction)
  const many = Array.from({ length: H.MAX_IDENTITIES_PER_RUN + 1 }, (_, i) => 'i' + i)
  const r = H.preflightPublish({ fields, params: { text: 'hi' }, identityIds: many })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'tooManyTargets')
})
ok('preflight rejects invalid params', () => {
  const fields = H.fieldsFromSchema(xAction)
  const r = H.preflightPublish({ fields, params: {}, identityIds: ['a'] })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'invalidParams')
})
ok('preflight passes a valid request', () => {
  const fields = H.fieldsFromSchema(xAction)
  const r = H.preflightPublish({
    fields,
    params: { text: 'hi' },
    identityIds: ['a'],
  })
  assert.strictEqual(r.ok, true)
})

section('history helpers (Etapa 2-A)')
ok('isPublishRun matches publish runs only (meta or {meta})', () => {
  assert.strictEqual(H.isPublishRun({ actionId: 'ig_post' }), true)
  assert.strictEqual(H.isPublishRun({ meta: { actionId: 'x_post' } }), true)
  assert.strictEqual(H.isPublishRun({ meta: { actionId: 'ig_like' } }), false)
  assert.strictEqual(H.isPublishRun(null), false)
})
ok('filterPublishRuns keeps only publish runs', () => {
  const rows = [
    { meta: { actionId: 'ig_post', runId: '1' } },
    { meta: { actionId: 'echo', runId: '2' } },
    { meta: { actionId: 'x_post', runId: '3' } },
  ]
  assert.deepStrictEqual(
    H.filterPublishRuns(rows).map((r) => r.meta.runId),
    ['1', '3'],
  )
})
ok('runPlatformLabel resolves platform from a run summary', () => {
  assert.strictEqual(H.runPlatformLabel({ meta: { actionId: 'ig_post' } }), 'Instagram')
  assert.strictEqual(H.runPlatformLabel({ actionId: 'x_post' }), 'X (Twitter)')
})
ok('countItems tallies every status bucket', () => {
  const c = H.countItems([
    { status: 'success' },
    { status: 'success' },
    { status: 'failed' },
    { status: 'skipped' },
    { status: 'weird' },
  ])
  assert.strictEqual(c.total, 5)
  assert.strictEqual(c.success, 2)
  assert.strictEqual(c.failed, 1)
  assert.strictEqual(c.skipped, 1)
  assert.strictEqual(c.running, 0)
})

section('scheduling + drip (Etapa 3)')
ok('buildPublishSpec includes options only when set', () => {
  const a = H.buildPublishSpec({
    actionId: 'x_post',
    identityIds: ['a'],
    params: { text: 'hi' },
  })
  assert.strictEqual('options' in a, false)
  const b = H.buildPublishSpec({
    actionId: 'x_post',
    identityIds: ['a'],
    params: { text: 'hi' },
    options: { minDelayMs: 1000, maxDelayMs: 1500 },
  })
  assert.deepStrictEqual(b.options, { minDelayMs: 1000, maxDelayMs: 1500 })
})
ok('dripOptions: 0/empty -> undefined, positive -> ms band', () => {
  assert.strictEqual(H.dripOptions(0), undefined)
  assert.strictEqual(H.dripOptions(''), undefined)
  assert.deepStrictEqual(H.dripOptions(60), { minDelayMs: 60000, maxDelayMs: 90000 })
})
ok('buildSchedule validates daily/weekly/everyMinutes', () => {
  assert.deepStrictEqual(H.buildSchedule({ mode: 'daily', time: '09:30' }), {
    type: 'daily',
    time: '09:30',
  })
  assert.strictEqual(H.buildSchedule({ mode: 'daily', time: '9:30' }), null)
  assert.deepStrictEqual(H.buildSchedule({ mode: 'weekly', day: 'mon', time: '08:00' }), {
    type: 'weekly',
    day: 'mon',
    time: '08:00',
  })
  assert.strictEqual(H.buildSchedule({ mode: 'weekly', day: 'xxx', time: '08:00' }), null)
  assert.deepStrictEqual(H.buildSchedule({ mode: 'everyMinutes', minutes: 30 }), {
    type: 'every-minutes',
    minutes: 30,
  })
  assert.strictEqual(H.buildSchedule({ mode: 'everyMinutes', minutes: 0 }), null)
})
ok('buildScheduleInput produces a valid scheduler create input', () => {
  const input = H.buildScheduleInput({
    name: 'Daily IG',
    actionId: 'ig_post',
    identityIds: ['a', 'b'],
    params: { imagePath: '/x.jpg' },
    schedule: { type: 'daily', time: '09:00' },
  })
  assert.strictEqual(input.action, 'bulk')
  assert.strictEqual(input.enabled, true)
  assert.deepStrictEqual(input.schedule, { type: 'daily', time: '09:00' })
  assert.strictEqual(input.params.spec.actionId, 'ig_post')
  assert.deepStrictEqual(input.params.spec.identityIds, ['a', 'b'])
})
ok('isPublishScheduledAction + scheduledPlatformLabel', () => {
  const a = {
    action: 'bulk',
    params: { spec: { actionId: 'ig_post', identityIds: ['x'] } },
  }
  const b = { action: 'bulk', params: { spec: { actionId: 'echo', identityIds: ['x'] } } }
  const c = { action: 'openWorkspace', params: {} }
  assert.strictEqual(H.isPublishScheduledAction(a), true)
  assert.strictEqual(H.isPublishScheduledAction(b), false)
  assert.strictEqual(H.isPublishScheduledAction(c), false)
  assert.strictEqual(H.scheduledPlatformLabel(a), 'Instagram')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
