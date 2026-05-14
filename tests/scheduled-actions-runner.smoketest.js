// OZ Browser — Scheduled Actions runner smoke test (F-1, v1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/scheduled-actions-runner.smoketest.js
//
// Cubre el lado "runner" del módulo (la otra mitad de F-1 vive en
// tests/scheduled-actions.smoketest.js — split por ADR 0005 ≤500 LOC):
//   - computeNextRunAt pure function — every-minutes, daily, weekly,
//     anti-double-fire
//   - tick() fires only due actions, updates lastRunAt + lastResult,
//     preserves handler return value
//   - handler errors → 'action-failed' + lastResult.ok=false (no crash)
//   - missing handler → action-failed with code NO_HANDLER
//   - reentrancy: in-flight action is skipped on overlapping tick
//   - setEnabled disables firing
//   - start/stop runner sanity

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  ScheduledActions,
  computeNextRunAt,
  DAYS,
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

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-sched-'))
  return path.join(dir, name)
}

function makeClock(start) {
  const state = { now: start }
  const fn = () => state.now
  fn.advance = (ms) => {
    state.now += ms
  }
  fn.set = (v) => {
    state.now = v
  }
  return fn
}

function finalReport() {
  console.log(`\n=== passed=${passed} failed=${failed} ===`)
  if (failed > 0) {
    for (const f of failures) {
      console.error(`  ✗ ${f.label}${f.detail ? ' — ' + f.detail : ''}`)
    }
    process.exit(1)
  }
}

// ===========================================================================
// computeNextRunAt — pure time math
// ===========================================================================
console.log('\n[computeNextRunAt — pure time math]')

{
  // every-minutes: anchor + N*60_000
  const createdAt = 1_700_000_000_000
  const sched = { type: 'every-minutes', minutes: 30 }
  ok(
    'every-minutes first fire = createdAt + N*60s',
    computeNextRunAt(sched, null, createdAt + 1000, createdAt) ===
      createdAt + 30 * 60_000,
  )
  ok(
    'every-minutes after lastRun = lastRunAt + N*60s',
    computeNextRunAt(
      sched,
      createdAt + 60 * 60_000,
      createdAt + 70 * 60_000,
      createdAt,
    ) ===
      createdAt + 60 * 60_000 + 30 * 60_000,
  )

  // daily — pick a wall-clock NOW that's local 08:00 today, schedule for 09:00
  // → next should be ~3600s later. We use the runtime's local TZ; no DST
  // crossings inside a single test.
  const now = new Date()
  now.setHours(8, 0, 0, 0)
  const nowMs = now.getTime()
  const expected09 = new Date(now)
  expected09.setHours(9, 0, 0, 0)
  ok(
    'daily 09:00 from local 08:00 → +1h',
    computeNextRunAt({ type: 'daily', time: '09:00' }, null, nowMs, nowMs) ===
      expected09.getTime(),
  )

  // If "now" is already past 09:00 the same day → push to tomorrow 09:00.
  const past = new Date()
  past.setHours(10, 0, 0, 0)
  const pastMs = past.getTime()
  const tomorrow09 = new Date(past)
  tomorrow09.setDate(tomorrow09.getDate() + 1)
  tomorrow09.setHours(9, 0, 0, 0)
  ok(
    'daily 09:00 after 10:00 → tomorrow 09:00',
    computeNextRunAt({ type: 'daily', time: '09:00' }, null, pastMs, pastMs) ===
      tomorrow09.getTime(),
  )

  // anti-double-fire — if lastRunAt equals today's HH:MM slot, push tomorrow.
  const dailyTarget = new Date()
  dailyTarget.setHours(9, 0, 0, 0)
  const dailyTargetMs = dailyTarget.getTime()
  // pretend "now" is the same exact moment 09:00, and we just fired.
  const nextAfterFire = computeNextRunAt(
    { type: 'daily', time: '09:00' },
    /*lastRunAt=*/ dailyTargetMs,
    /*now=*/ dailyTargetMs,
    /*createdAt=*/ dailyTargetMs - 1000,
  )
  const tmrw = new Date(dailyTarget)
  tmrw.setDate(tmrw.getDate() + 1)
  ok('daily anti-double-fire — push to tomorrow', nextAfterFire === tmrw.getTime())

  // weekly — pick a weekday FAR from now, expect 1..7 days forward
  const weekdayNow = new Date()
  weekdayNow.setHours(8, 0, 0, 0)
  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const next = computeNextRunAt(
      { type: 'weekly', day: DAYS[dayIdx], time: '09:00' },
      null,
      weekdayNow.getTime(),
      weekdayNow.getTime(),
    )
    const nextDate = new Date(next)
    ok(
      `weekly resolves to ${DAYS[dayIdx]}`,
      nextDate.getDay() === dayIdx &&
        nextDate.getHours() === 9 &&
        nextDate.getMinutes() === 0 &&
        next > weekdayNow.getTime() &&
        next <= weekdayNow.getTime() + 7 * 86_400_000,
    )
  }
}

// ===========================================================================
// tick — firing semantics
// ===========================================================================
async function runTickSemantics() {
  console.log('\n[tick — firing semantics]')

  const fp = tmpFile('sa.json')
  const clock = makeClock(1_700_000_000_000)
  const calls = { syncPush: 0, openWs: [] }
  const s = new ScheduledActions({
    filePath: fp,
    clock,
    handlers: {
      'sync-push': async () => {
        calls.syncPush++
        return { didPush: true }
      },
      'open-workspace': async (params, ctx) => {
        calls.openWs.push({ params, ctx })
        return 'ok'
      },
    },
  })
  s.load()

  const a = s.create({
    name: 'every-1-min',
    action: 'sync-push',
    schedule: { type: 'every-minutes', minutes: 1 },
  })
  const b = s.create({
    name: 'every-5-min',
    action: 'open-workspace',
    params: { workspaceId: 'ws-A' },
    schedule: { type: 'every-minutes', minutes: 5 },
  })

  ok('size = 2', s.size() === 2)
  ok('a.lastRunAt is null', s.get(a.id).lastRunAt === null)

  // Tick at t+0 → neither due (anchor is createdAt, next = createdAt+Nmin).
  await s.tick(clock())
  ok('t=0: nothing fired', calls.syncPush === 0 && calls.openWs.length === 0)

  // Advance 90s — only the 1-min one is due.
  clock.advance(90_000)
  await s.tick(clock())
  ok('t=90s: only 1-min fired once', calls.syncPush === 1 && calls.openWs.length === 0)

  const a2 = s.get(a.id)
  ok('a.lastRunAt updated', typeof a2.lastRunAt === 'number')
  ok('a.lastResult.ok=true', a2.lastResult && a2.lastResult.ok === true)
  ok(
    'a.lastResult.value preserved',
    a2.lastResult && a2.lastResult.value && a2.lastResult.value.didPush === true,
  )

  // Advance another 60s — 1-min due again, 5-min still not.
  clock.advance(60_000)
  await s.tick(clock())
  ok(
    't=150s: 1-min fired twice, 5-min still 0',
    calls.syncPush === 2 && calls.openWs.length === 0,
  )

  // Jump to t+300s — 5-min finally due.
  clock.advance(150_000)
  await s.tick(clock())
  ok(
    't=300s: 5-min fired',
    calls.openWs.length === 1 &&
      calls.openWs[0].params.workspaceId === 'ws-A' &&
      calls.openWs[0].ctx.actionId === b.id,
  )
}

// ===========================================================================
// error paths — handler errors, missing handler, reentrancy, disable
// ===========================================================================
async function runErrorPaths() {
  console.log('\n[error paths]')

  const fp = tmpFile('sa.json')
  const clock = makeClock(1_700_000_000_000)
  let throwsCount = 0
  let slowResolves
  const slowPromise = new Promise((r) => {
    slowResolves = r
  })
  const events = { fired: [], failed: [], skipped: [] }

  const s = new ScheduledActions({
    filePath: fp,
    clock,
    handlers: {
      'sync-push': async () => {
        throwsCount++
        throw new Error('dropbox 500')
      },
      slow: async () => slowPromise,
      // 'orphan' intentionally NOT registered
    },
  })
  s.on('action-fired', (e) => events.fired.push(e))
  s.on('action-failed', (e) => events.failed.push(e))
  s.on('action-skipped', (e) => events.skipped.push(e))
  s.load()

  const errAction = s.create({
    name: 'will-fail',
    action: 'sync-push',
    schedule: { type: 'every-minutes', minutes: 1 },
  })
  const orphanAction = s.create({
    name: 'no-handler',
    action: 'orphan',
    schedule: { type: 'every-minutes', minutes: 1 },
  })
  const slowAction = s.create({
    name: 'slow',
    action: 'slow',
    schedule: { type: 'every-minutes', minutes: 1 },
  })

  clock.advance(70_000)
  // Don't await — we want to test overlapping ticks for `slow`.
  const tickPromise = s.tick(clock())

  // While the first tick is running, fire another tick — slow should be
  // skipped because it's in-flight.
  await new Promise((r) => setTimeout(r, 5))
  await s.tick(clock())
  ok(
    'reentrancy: slow skipped on overlap',
    events.skipped.some((e) => e.id === slowAction.id && e.reason === 'in-flight'),
  )

  // Let slow resolve so the first tick can complete.
  slowResolves('done')
  await tickPromise

  ok('handler that throws → action-failed', throwsCount === 1)
  ok(
    'failed action has lastResult.ok=false',
    s.get(errAction.id).lastResult && s.get(errAction.id).lastResult.ok === false,
  )
  ok(
    'failed action error message preserved',
    s.get(errAction.id).lastResult.error === 'dropbox 500',
  )
  ok(
    'orphan handler → action-failed with NO_HANDLER',
    s.get(orphanAction.id).lastResult &&
      s.get(orphanAction.id).lastResult.ok === false &&
      s.get(orphanAction.id).lastResult.code === 'NO_HANDLER',
  )
  ok(
    'action-failed events emitted for both',
    events.failed.filter((e) => e.id === errAction.id).length === 1 &&
      events.failed.filter((e) => e.id === orphanAction.id).length === 1,
  )
  ok(
    'slow eventually fired ok',
    events.fired.some((e) => e.id === slowAction.id) &&
      s.get(slowAction.id).lastResult.ok === true,
  )

  // Disable + tick again → nothing fires.
  const beforeCount = throwsCount
  s.setEnabled(errAction.id, false)
  clock.advance(120_000)
  await s.tick(clock())
  ok('disabled action does not fire', throwsCount === beforeCount)
  ok('setEnabled persisted', s.get(errAction.id).enabled === false)

  // start/stop runner sanity
  s.start({ intervalMs: 10 })
  ok('start sets isRunning', s.isRunning() === true)
  await s.stop()
  ok('stop clears isRunning', s.isRunning() === false)
}

// ===========================================================================
// runner
// ===========================================================================
;(async () => {
  await runTickSemantics()
  await runErrorPaths()
  finalReport()
})().catch((err) => {
  console.error('UNEXPECTED ERR:', err)
  process.exit(2)
})
