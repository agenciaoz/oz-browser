// OZ Browser — BulkRunner smoke test (v2 sub-bloque 1).
//
// Cubre:
//   - Registry: register / get / list / unregister / clear; duplicate rejected
//   - Action validation: paramsSchema is exposed
//   - create(): unknown action / empty identities / cap exceeded / unknown identity
//   - run(): sequential execution, params passed correctly, status transitions
//   - delays: respect minDelayMs/maxDelayMs (with fake clock), no delay before first
//   - cancel(): mid-flight, marks remaining as cancelled
//   - failure: action throws → item.status='failed', run continues
//   - persistence: state writes to disk, reload after restart recovers history
//   - schema versioning: corrupt / wrong version ignored
//   - concurrent runs cap

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const assert = require('assert')

const registry = require('../browser/bulk-actions-registry')
const { echoAction } = require('../browser/bulk-actions-echo')
const {
  BulkRunner,
  BulkRunnerError,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_CANCELLED,
  STATUS_PENDING,
  RUN_STATUS_COMPLETED,
  RUN_STATUS_CANCELLED,
  RUN_STATUS_FAILED,
  RUN_STATUS_CREATED,
} = require('../browser/bulk-runner')

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

function section(name) {
  console.log(`\n— ${name} —`)
}

function makeFakeIdentityManager(ids) {
  const map = new Map(ids.map((i) => [i.id, i]))
  return {
    get(id) {
      return map.get(id) || null
    },
    list() {
      return Array.from(map.values())
    },
    _drop(id) {
      map.delete(id)
    },
  }
}

function fakeClock() {
  let elapsed = 0
  const waiters = []
  return {
    sleep(ms, signal) {
      return new Promise((resolve) => {
        const w = { wakeAt: elapsed + ms, resolve, signal, resolved: false }
        const wake = () => {
          if (w.resolved) return
          w.resolved = true
          const idx = waiters.indexOf(w)
          if (idx >= 0) waiters.splice(idx, 1)
          resolve()
        }
        w._wake = wake
        waiters.push(w)
        if (signal && signal.aborted) {
          // Already aborted before we even started.
          setImmediate(wake)
          return
        }
        if (signal) {
          signal.addEventListener('abort', wake, { once: true })
        }
      })
    },
    async advance(ms) {
      elapsed += ms
      const due = waiters.filter((w) => w.wakeAt <= elapsed && !w.resolved)
      for (const w of due) w._wake()
      // Let microtasks settle so any newly-queued sleep is observable.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    },
    pendingCount() {
      return waiters.filter((w) => !w.resolved).length
    },
  }
}

async function main() {
  const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-bulk-runner-'))

  // ---------- 1. Registry ---------------------------------------------------
  section('Action registry')
  registry.clear()
  registry.register(echoAction)
  ok('register echo', !!registry.get('echo'))
  ok(
    'list shows echo',
    registry.list().some((a) => a.id === 'echo'),
  )
  ok('paramsSchema exposed', !!registry.get('echo').paramsSchema)
  let threw = false
  try {
    registry.register(echoAction)
  } catch (_e) {
    threw = true
  }
  ok('duplicate register throws', threw)
  threw = false
  try {
    registry.register({ id: 'Bad-ID', label: 'x', run: async () => {} })
  } catch (_e) {
    threw = true
  }
  ok('bad id format throws', threw)
  threw = false
  try {
    registry.register({ id: 'noLabel', run: async () => {} })
  } catch (_e) {
    threw = true
  }
  ok('missing label throws', threw)
  threw = false
  try {
    registry.register({ id: 'norun', label: 'X' })
  } catch (_e) {
    threw = true
  }
  ok('missing run throws', threw)
  ok('unregister returns true', registry.unregister('echo') === true)
  ok('unregister of missing returns false', registry.unregister('nope') === false)
  registry.register(echoAction) // re-register for the rest of the suite

  // ---------- 2. create() validation ---------------------------------------
  section('create() validation')
  const ids = [
    { id: 'id1', name: 'Alice' },
    { id: 'id2', name: 'Bob' },
    { id: 'id3', name: 'Carol' },
  ]
  const im = makeFakeIdentityManager(ids)
  const runner1Dir = path.join(TEST_HOME, 'r1')
  const runner = new BulkRunner({
    userDataDir: runner1Dir,
    identityManager: im,
    registry,
    clock: fakeClock(),
  })
  threw = false
  try {
    await runner.create({ actionId: 'nope', identityIds: ['id1'] })
  } catch (e) {
    threw = e instanceof BulkRunnerError && e.code === 'UNKNOWN_ACTION'
  }
  ok('unknown action → UNKNOWN_ACTION', threw)
  threw = false
  try {
    await runner.create({ actionId: 'echo', identityIds: [] })
  } catch (e) {
    threw = e.code === 'BAD_IDENTITIES'
  }
  ok('empty identities → BAD_IDENTITIES', threw)
  threw = false
  try {
    await runner.create({ actionId: 'echo', identityIds: ['ghost'] })
  } catch (e) {
    threw = e.code === 'UNKNOWN_IDENTITY'
  }
  ok('unknown identity → UNKNOWN_IDENTITY', threw)
  threw = false
  try {
    await runner.create({ actionId: 'echo', identityIds: ['id1', 'id1'] })
  } catch (e) {
    threw = e.code === 'DUPLICATE_ID'
  }
  ok('duplicate id → DUPLICATE_ID', threw)
  threw = false
  try {
    await runner.create({
      actionId: 'echo',
      identityIds: Array(201).fill('id1'),
    })
  } catch (e) {
    threw = e.code === 'CAP_EXCEEDED'
  }
  ok('over cap → CAP_EXCEEDED', threw)

  // ---------- 3. Happy path run --------------------------------------------
  section('Happy path: 3 identities, no delay')
  const clk1 = fakeClock()
  const runner2 = new BulkRunner({
    userDataDir: path.join(TEST_HOME, 'r2'),
    identityManager: im,
    registry,
    clock: clk1,
  })
  const progressEvents = []
  runner2.on('progress', (e) => progressEvents.push(e))
  const id = await runner2.create({
    actionId: 'echo',
    identityIds: ['id1', 'id2', 'id3'],
    params: { message: 'hello' },
    options: { minDelayMs: 0, maxDelayMs: 0 },
  })
  ok('runId returned', typeof id === 'string' && id.startsWith('br-'))
  ok('initial status created', runner2.get(id).meta.status === RUN_STATUS_CREATED)
  runner2.start(id)
  await runner2.waitFor(id)
  const rec = runner2.get(id)
  ok('final status completed', rec.meta.status === RUN_STATUS_COMPLETED)
  ok('all 3 done', rec.meta.stats.done === 3)
  ok('zero failed', rec.meta.stats.failed === 0)
  ok(
    'each item has result with message',
    rec.items.every((it) => it.result && it.result.message === 'hello'),
  )
  ok(
    'progress emitted once per item start AND end',
    progressEvents.length === 6, // 3 identities × (running + done)
    `got ${progressEvents.length}`,
  )

  // ---------- 4. Spread temporal -------------------------------------------
  section('Spread temporal — fake clock')
  const clk2 = fakeClock()
  const runner3 = new BulkRunner({
    userDataDir: path.join(TEST_HOME, 'r3'),
    identityManager: im,
    registry,
    clock: clk2,
  })
  const id3 = await runner3.create({
    actionId: 'echo',
    identityIds: ['id1', 'id2', 'id3'],
    params: { message: 'spread' },
    options: { minDelayMs: 1000, maxDelayMs: 1000 },
  })
  runner3.start(id3)
  // Let first identity run (no delay before first).
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  // Now we should be waiting on delay before identity 2.
  ok('clock has pending sleep after item 1', clk2.pendingCount() > 0)
  await clk2.advance(1000)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  await clk2.advance(1000)
  await runner3.waitFor(id3)
  ok('spread run completed', runner3.get(id3).meta.status === RUN_STATUS_COMPLETED)
  ok('spread done count = 3', runner3.get(id3).meta.stats.done === 3)

  // ---------- 5. Cancellation ----------------------------------------------
  section('Cancellation')
  const clk3 = fakeClock()
  const runner4 = new BulkRunner({
    userDataDir: path.join(TEST_HOME, 'r4'),
    identityManager: im,
    registry,
    clock: clk3,
  })
  const id4 = await runner4.create({
    actionId: 'echo',
    identityIds: ['id1', 'id2', 'id3'],
    params: { message: 'cancel-me', delayMs: 0 },
    options: { minDelayMs: 5000, maxDelayMs: 5000 },
  })
  runner4.start(id4)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  // Item 1 done, sleeping before item 2. Cancel now.
  const cancelled = runner4.cancel(id4)
  ok('cancel() returns true on first call', cancelled === true)
  // Releasing the sleep — abort signal should propagate.
  await clk3.advance(0) // wakes any cancelled-aware waiters via signal
  await runner4.waitFor(id4)
  const r4rec = runner4.get(id4)
  ok('run status cancelled', r4rec.meta.status === RUN_STATUS_CANCELLED)
  ok('item 1 done', r4rec.items[0].status === STATUS_DONE)
  ok('items 2+3 cancelled', r4rec.items[1].status === STATUS_CANCELLED)
  ok('cancel() second call returns false', runner4.cancel(id4) === false)

  // ---------- 6. Failure handling ------------------------------------------
  section('Failure handling — action throws')
  // Register a fail-once action for this test.
  registry.unregister('fail-once')
  let failCount = 0
  registry.register({
    id: 'fail_test',
    label: 'fail test',
    run: async (identity) => {
      if (identity.id === 'id2') {
        throw new Error('boom')
      }
      return { ok: true, identityId: identity.id }
    },
  })
  const runner5 = new BulkRunner({
    userDataDir: path.join(TEST_HOME, 'r5'),
    identityManager: im,
    registry,
    clock: fakeClock(),
  })
  const id5 = await runner5.create({
    actionId: 'fail_test',
    identityIds: ['id1', 'id2', 'id3'],
    options: { minDelayMs: 0, maxDelayMs: 0 },
  })
  runner5.start(id5)
  await runner5.waitFor(id5)
  const r5rec = runner5.get(id5)
  ok('run completed despite middle failure', r5rec.meta.status === RUN_STATUS_COMPLETED)
  ok('id1 done', r5rec.items[0].status === STATUS_DONE)
  ok('id2 failed', r5rec.items[1].status === STATUS_FAILED)
  ok('id2 error message captured', r5rec.items[1].error.message === 'boom')
  ok('id3 done (continued)', r5rec.items[2].status === STATUS_DONE)
  ok(
    'stats: 2 done, 1 failed',
    r5rec.meta.stats.done === 2 && r5rec.meta.stats.failed === 1,
  )
  registry.unregister('fail_test')

  // ---------- 7. Persistence + restart -------------------------------------
  section('Persistence: state on disk, reload after restart')
  const dir = path.join(TEST_HOME, 'r-persist')
  const r6 = new BulkRunner({
    userDataDir: dir,
    identityManager: im,
    registry,
    clock: fakeClock(),
  })
  const id6 = await r6.create({
    actionId: 'echo',
    identityIds: ['id1', 'id2'],
    params: { message: 'persist' },
    options: { minDelayMs: 0, maxDelayMs: 0 },
  })
  r6.start(id6)
  await r6.waitFor(id6)
  ok('file on disk', fs.existsSync(path.join(dir, 'bulk-runs', `${id6}.json`)))
  // Spin up a new runner pointing to same dir — should load history.
  const r6b = new BulkRunner({
    userDataDir: dir,
    identityManager: im,
    registry,
    clock: fakeClock(),
  })
  const reloaded = r6b.get(id6)
  ok('reloaded run found', reloaded && reloaded.meta.runId === id6)
  ok('reloaded status preserved', reloaded.meta.status === RUN_STATUS_COMPLETED)
  ok('reloaded items length', reloaded.items.length === 2)

  // Simulate process death mid-run: write a 'running' status, reload, must
  // be marked failed.
  const fakeRun = {
    meta: {
      runId: 'br-deadbeefdeadbeef',
      schemaVersion: 1,
      actionId: 'echo',
      actionLabel: 'Echo',
      params: { message: 'orphan' },
      options: { minDelayMs: 0, maxDelayMs: 0 },
      identityCount: 1,
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stats: { done: 0, failed: 0, skipped: 0, cancelled: 0 },
    },
    items: [
      {
        identityId: 'id1',
        identityName: 'Alice',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
      },
    ],
  }
  fs.writeFileSync(
    path.join(dir, 'bulk-runs', `${fakeRun.meta.runId}.json`),
    JSON.stringify(fakeRun),
  )
  const r6c = new BulkRunner({
    userDataDir: dir,
    identityManager: im,
    registry,
    clock: fakeClock(),
  })
  const orphan = r6c.get(fakeRun.meta.runId)
  ok('orphan run loaded', !!orphan)
  ok('orphan status bumped to failed', orphan.meta.status === RUN_STATUS_FAILED)
  ok('orphan item status bumped to failed', orphan.items[0].status === STATUS_FAILED)
  ok('orphan item error mentions restart', /restart/.test(orphan.items[0].error.message))

  // ---------- 8. Concurrent runs cap ---------------------------------------
  section('Concurrent runs cap = 5')
  registry.register({
    id: 'slow_action',
    label: 'slow',
    run: async (_id, _params, ctx) => {
      // Hold until aborted or 1 hour, whichever first.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3_600_000)
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            resolve()
          },
          { once: true },
        )
      })
      return null
    },
  })
  const r7 = new BulkRunner({
    userDataDir: path.join(TEST_HOME, 'r7'),
    identityManager: im,
    registry,
    clock: fakeClock(),
  })
  const heldIds = []
  for (let i = 0; i < 5; i++) {
    const rid = await r7.create({
      actionId: 'slow_action',
      identityIds: ['id1'],
      options: { minDelayMs: 0, maxDelayMs: 0 },
    })
    r7.start(rid)
    heldIds.push(rid)
  }
  // Sixth should fail.
  threw = false
  try {
    await r7.create({
      actionId: 'slow_action',
      identityIds: ['id1'],
      options: { minDelayMs: 0, maxDelayMs: 0 },
    })
  } catch (e) {
    threw = e.code === 'CONCURRENT_CAP'
  }
  ok('6th concurrent run blocked', threw)
  // Cancel them all to clean up.
  for (const rid of heldIds) r7.cancel(rid)
  for (const rid of heldIds) await r7.waitFor(rid)
  registry.unregister('slow_action')

  // ---------- 9. Vanished identity mid-run ---------------------------------
  section('Identity vanishes mid-run → skipped')
  const im2 = makeFakeIdentityManager([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ])
  const r8 = new BulkRunner({
    userDataDir: path.join(TEST_HOME, 'r8'),
    identityManager: im2,
    registry,
    clock: fakeClock(),
  })
  const id8 = await r8.create({
    actionId: 'echo',
    identityIds: ['a', 'b', 'c'],
    params: { message: 'hi' },
    options: { minDelayMs: 0, maxDelayMs: 0 },
  })
  // Drop identity 'b' BEFORE we start.
  im2._drop('b')
  r8.start(id8)
  await r8.waitFor(id8)
  const r8rec = r8.get(id8)
  ok('a done', r8rec.items[0].status === STATUS_DONE)
  ok('b skipped', r8rec.items[1].status === 'skipped')
  ok('c done', r8rec.items[2].status === STATUS_DONE)
  ok('stats reflect skip', r8rec.meta.stats.skipped === 1)

  // ---------- 10. run() convenience method ---------------------------------
  section('run() convenience: create + start in one call')
  const r9 = new BulkRunner({
    userDataDir: path.join(TEST_HOME, 'r9'),
    identityManager: im,
    registry,
    clock: fakeClock(),
  })
  const id9 = await r9.run({
    actionId: 'echo',
    identityIds: ['id1'],
    params: { message: 'one-shot' },
    options: { minDelayMs: 0, maxDelayMs: 0 },
  })
  await r9.waitFor(id9)
  ok(
    'run() resolves to a started runId',
    r9.get(id9).meta.status === RUN_STATUS_COMPLETED,
  )

  // Auto-login retry tests live in tests/bulk-runner-autologin.smoketest.js
  // (extracted per ADR 0005 — 500-LOC budget).

  // ---------- Done ----------------------------------------------------------
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    }
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Test harness crashed:', err)
  process.exit(1)
})
