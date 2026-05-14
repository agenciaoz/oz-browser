// OZ Browser — Scheduled Actions smoke test — store/CRUD (F-1, v1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/scheduled-actions.smoketest.js
//
// Cubre el lado "store" del módulo:
//   - validation (name / action / params / enabled / schedule shapes)
//   - CRUD round-trip via save+reload
//   - schema mismatch + corrupt JSON → warn + start fresh
//   - update() refuses reserved-field patches
//   - MAX_ACTIONS cap
//
// La parte runner (computeNextRunAt + tick + error paths) está en
// tests/scheduled-actions-runner.smoketest.js (split por ADR 0005, ≤500 LOC).

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  ScheduledActions,
  SCHEMA_VERSION,
  MAX_ACTIONS,
} = require('../browser/scheduled-actions')

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

function throwsWithCode(label, fn, code) {
  let caught = null
  try {
    fn()
  } catch (e) {
    caught = e
  }
  ok(
    label,
    !!caught && caught.code === code,
    caught ? `caught code=${caught.code} message=${caught.message}` : 'did not throw',
  )
}

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-sched-'))
  return path.join(dir, name)
}

// ===========================================================================
// validation
// ===========================================================================
console.log('\n[validation]')

{
  const fp = tmpFile('sa.json')
  const s = new ScheduledActions({ filePath: fp, clock: () => 1_700_000_000_000 })
  s.load()

  throwsWithCode(
    'create rejects empty name',
    () =>
      s.create({
        name: '',
        action: 'sync-push',
        schedule: { type: 'every-minutes', minutes: 30 },
      }),
    'BAD_NAME',
  )

  throwsWithCode(
    'create rejects empty action',
    () =>
      s.create({
        name: 'n',
        action: '',
        schedule: { type: 'every-minutes', minutes: 30 },
      }),
    'BAD_ACTION_NAME',
  )

  throwsWithCode(
    'create rejects array params',
    () =>
      s.create({
        name: 'n',
        action: 'sync-push',
        params: [1, 2, 3],
        schedule: { type: 'every-minutes', minutes: 30 },
      }),
    'BAD_PARAMS',
  )

  throwsWithCode(
    'every-minutes rejects 0',
    () =>
      s.create({
        name: 'n',
        action: 'sync-push',
        schedule: { type: 'every-minutes', minutes: 0 },
      }),
    'BAD_MINUTES',
  )

  throwsWithCode(
    'every-minutes rejects 1441',
    () =>
      s.create({
        name: 'n',
        action: 'sync-push',
        schedule: { type: 'every-minutes', minutes: 1441 },
      }),
    'BAD_MINUTES',
  )

  throwsWithCode(
    'daily rejects bad HH:MM',
    () =>
      s.create({
        name: 'n',
        action: 'sync-push',
        schedule: { type: 'daily', time: '25:00' },
      }),
    'BAD_TIME',
  )

  throwsWithCode(
    'daily rejects garbage time',
    () =>
      s.create({
        name: 'n',
        action: 'sync-push',
        schedule: { type: 'daily', time: 'nope' },
      }),
    'BAD_TIME',
  )

  throwsWithCode(
    'weekly rejects unknown day',
    () =>
      s.create({
        name: 'n',
        action: 'sync-push',
        schedule: { type: 'weekly', day: 'funday', time: '09:00' },
      }),
    'BAD_DAY',
  )

  throwsWithCode(
    'unknown schedule.type rejected',
    () =>
      s.create({
        name: 'n',
        action: 'sync-push',
        schedule: { type: 'cron', expr: '* * * * *' },
      }),
    'BAD_SCHEDULE_TYPE',
  )

  // Valid creates of all three flavors
  const a1 = s.create({
    name: 'A',
    action: 'sync-push',
    schedule: { type: 'every-minutes', minutes: 30 },
  })
  ok('valid every-minutes creates', a1 && a1.id && a1.enabled === true)

  const a2 = s.create({
    name: 'B',
    action: 'open-workspace',
    params: { workspaceId: 'ws-1' },
    schedule: { type: 'daily', time: '07:30' },
  })
  ok('valid daily creates with params', a2 && a2.params.workspaceId === 'ws-1')

  const a3 = s.create({
    name: 'C',
    action: 'backup-snapshot',
    schedule: { type: 'weekly', day: 'mon', time: '03:00' },
  })
  ok('valid weekly creates', a3 && a3.schedule.day === 'mon')
}

// ===========================================================================
// CRUD round-trip via save + reload
// ===========================================================================
console.log('\n[CRUD round-trip]')

{
  const fp = tmpFile('sa.json')
  let lastId = null
  {
    const s = new ScheduledActions({
      filePath: fp,
      clock: () => 1_700_000_000_000,
      idGen: (() => {
        let i = 0
        return () => `id-${++i}`
      })(),
    })
    s.load()
    s.create({
      name: 'one',
      action: 'sync-push',
      schedule: { type: 'every-minutes', minutes: 10 },
    })
    const two = s.create({
      name: 'two',
      action: 'open-workspace',
      params: { workspaceId: 'ws-x' },
      schedule: { type: 'daily', time: '08:00' },
    })
    lastId = two.id
    ok('two actions stored', s.size() === 2)
    ok(
      'list returns clones (deep)',
      (() => {
        const list = s.list()
        list[0].name = 'mutated'
        return s.get(list[0].id).name !== 'mutated'
      })(),
    )
  }

  // Fresh instance → load from disk
  const s2 = new ScheduledActions({
    filePath: fp,
    clock: () => 1_700_000_000_000,
  })
  s2.load()
  ok('reload preserves size', s2.size() === 2)
  ok('reload preserves params', s2.get(lastId).params.workspaceId === 'ws-x')

  // update + remove
  const upd = s2.update(lastId, { name: 'two-renamed', enabled: false })
  ok('update bumps updatedAt', upd.updatedAt >= upd.createdAt)
  ok('update sets new name', upd.name === 'two-renamed')
  ok('update sets enabled=false', upd.enabled === false)

  throwsWithCode(
    'update refuses reserved id',
    () => s2.update(lastId, { id: 'hijack' }),
    'RESERVED_FIELD',
  )
  throwsWithCode(
    'update refuses reserved lastRunAt',
    () => s2.update(lastId, { lastRunAt: 12345 }),
    'RESERVED_FIELD',
  )
  throwsWithCode(
    'update unknown id',
    () => s2.update('does-not-exist', { name: 'x' }),
    'UNKNOWN_ACTION',
  )

  const removed = s2.remove(lastId)
  ok('remove returns true on hit', removed === true)
  ok('remove returns false on miss', s2.remove('nope') === false)
  ok('size after remove', s2.size() === 1)
}

// ===========================================================================
// schema mismatch + corrupt JSON
// ===========================================================================
console.log('\n[robustness on disk]')

{
  const fp = tmpFile('sa.json')
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, 'this is not JSON {{{')
  const warnings = []
  const s = new ScheduledActions({ filePath: fp, clock: () => 1 })
  s.on('warn', (w) => warnings.push(w))
  s.load()
  ok(
    'parse-failed warn emitted',
    warnings.some((w) => w.reason === 'parse-failed'),
  )
  ok('size 0 after corrupt load', s.size() === 0)
}

{
  const fp = tmpFile('sa.json')
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, JSON.stringify({ schemaVersion: 999, actions: [] }))
  const warnings = []
  const s = new ScheduledActions({ filePath: fp, clock: () => 1 })
  s.on('warn', (w) => warnings.push(w))
  s.load()
  ok(
    'schema-mismatch warn emitted',
    warnings.some((w) => w.reason === 'schema-mismatch'),
  )
  ok('size 0 after schema mismatch', s.size() === 0)
}

{
  const fp = tmpFile('sa.json')
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  // Mix of valid + invalid + missing-id
  fs.writeFileSync(
    fp,
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      actions: [
        {
          id: 'good',
          name: 'good',
          action: 'sync-push',
          params: {},
          schedule: { type: 'every-minutes', minutes: 5 },
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          lastRunAt: null,
          lastResult: null,
        },
        {
          // missing id
          name: 'no-id',
          action: 'sync-push',
          params: {},
          schedule: { type: 'every-minutes', minutes: 5 },
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'bad-schedule',
          name: 'broken',
          action: 'sync-push',
          params: {},
          schedule: { type: 'cron', expr: '*' },
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
  )
  const warnings = []
  const s = new ScheduledActions({ filePath: fp, clock: () => 1 })
  s.on('warn', (w) => warnings.push(w))
  s.load()
  ok('mixed file keeps the good one', s.size() === 1 && s.get('good'))
  ok(
    'mixed file warns about invalid',
    warnings.some((w) => w.reason === 'invalid-action-skipped'),
  )
  ok(
    'mixed file warns about missing-id',
    warnings.some((w) => w.reason === 'missing-id-skipped'),
  )
}

// ===========================================================================
// MAX_ACTIONS cap
// ===========================================================================
console.log('\n[caps]')

{
  const fp = tmpFile('sa.json')
  const s = new ScheduledActions({ filePath: fp, clock: () => 1 })
  s.load()
  for (let i = 0; i < MAX_ACTIONS; i++) {
    s.create({
      name: `n-${i}`,
      action: 'sync-push',
      schedule: { type: 'every-minutes', minutes: 30 },
    })
  }
  ok(`size at cap = ${MAX_ACTIONS}`, s.size() === MAX_ACTIONS)
  throwsWithCode(
    'create over cap throws TOO_MANY_ACTIONS',
    () =>
      s.create({
        name: 'over',
        action: 'sync-push',
        schedule: { type: 'every-minutes', minutes: 30 },
      }),
    'TOO_MANY_ACTIONS',
  )
}

console.log(`\n=== passed=${passed} failed=${failed} ===`)
if (failed > 0) {
  for (const f of failures) {
    console.error(`  ✗ ${f.label}${f.detail ? ' — ' + f.detail : ''}`)
  }
  process.exit(1)
}
