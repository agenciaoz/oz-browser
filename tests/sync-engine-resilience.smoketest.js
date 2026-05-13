// OZ Browser — Sync Engine resilience smoke test (D-3c-1 CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-engine-resilience.smoketest.js
//
// Cubre los caminos de error + concurrencia del engine. Split from
// sync-engine.smoketest.js per ADR 0005 (500 LOC rule).
//
//   - drainOnce upload failure → backoff escalates, op stays in queue
//   - drainOnce on success → backoff resets to schedule[0]
//   - backoff caps at the last schedule entry
//   - race-safe conditional remove: queue gets newer op mid-flight → not removed
//   - drainOnce skips upsert when record gone locally (RECORD_GONE)

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const { SyncQueue } = require('../browser/sync-queue')
const { SyncEngine } = require('../browser/sync-engine')

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

// ---------- Test doubles (mirrors sync-engine.smoketest.js) ----------------

function makeFakeVault() {
  const key = crypto.randomBytes(32)
  return {
    get isUnlocked() {
      return true
    },
    getMasterKey() {
      return key
    },
    _key: () => key,
  }
}

function makeFakeDropbox() {
  const store = new Map()
  const state = { nextError: null, uploadDelayMs: 0 }
  return {
    isAuthenticated() {
      return true
    },
    async upload(p, buf) {
      if (state.uploadDelayMs > 0) {
        await new Promise((r) => setTimeout(r, state.uploadDelayMs))
      }
      if (state.nextError) {
        const e = state.nextError
        state.nextError = null
        throw e
      }
      store.set(p, Buffer.from(buf))
    },
    _setNextError(err) {
      state.nextError = err
    },
    _setUploadDelay(ms) {
      state.uploadDelayMs = ms
    },
    _hasPath(p) {
      return store.has(p)
    },
  }
}

function makeFakeIdentitySource() {
  const emitter = new EventEmitter()
  const records = new Map()
  return {
    emitter,
    records,
    fetchRecord(recordId) {
      return records.get(recordId) || null
    },
    set(recordId, record) {
      records.set(recordId, record)
    },
    fire(payload) {
      emitter.emit('changed', payload)
    },
  }
}

function tmpQueueFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-syncengine-resil-'))
  return path.join(dir, 'sync-queue.json')
}

function makeEngine() {
  const vault = makeFakeVault()
  const dropbox = makeFakeDropbox()
  const queue = new SyncQueue({ filePath: tmpQueueFile() }).load()
  const engine = new SyncEngine({
    vault,
    dropbox,
    queue,
    deviceFolder: 'mac-aaaa1111',
    backoffSchedule: [10, 20, 40, 80],
    idleWaitMs: 10,
    scheduler: () => null,
    cancelScheduler: () => {},
  })
  return { engine, vault, dropbox, queue }
}

function makeIdentityRecord({
  id = 'rec-1',
  updatedAt = '2026-05-11T10:00:00.000Z',
} = {}) {
  return {
    id,
    name: 'Cliente IG #' + id,
    color: '#5b8def',
    fingerprintSeed: 'seed-' + id,
    createdAt: 1715346000000,
    updatedAt,
    isDefault: false,
    locked: false,
    workspaceId: 'general',
    userAgent: null,
  }
}

console.log('OZ Browser — sync-engine resilience smoke test')

// 1. Upload failure → backoff escalates, op stays
section('drainOnce: upload failure → backoff escalates')
;(async () => {
  const { engine, queue, dropbox } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  src.set('rec-fail', makeIdentityRecord({ id: 'rec-fail' }))
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'rec-fail',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })

  const before = engine.currentBackoffMs()
  dropbox._setNextError(new Error('network down'))
  const r1 = await engine.drainOnce()
  ok("first failure returns 'failed'", r1 === 'failed')
  ok('op still in queue', queue.size() === 1)
  const after1 = engine.currentBackoffMs()
  ok('backoff escalated after first failure', after1 > before)

  dropbox._setNextError(new Error('still down'))
  await engine.drainOnce()
  const after2 = engine.currentBackoffMs()
  ok('backoff escalated again after second failure', after2 >= after1)

  // Cap test — drive past the schedule length.
  for (let i = 0; i < 10; i++) {
    dropbox._setNextError(new Error('still down ' + i))
    await engine.drainOnce()
  }
  ok('backoff caps at the last schedule entry', engine.currentBackoffMs() === 80)

  // Now succeed once — backoff should reset.
  const r2 = await engine.drainOnce()
  ok("eventual success returns 'pushed'", r2 === 'pushed')
  ok('backoff reset to schedule[0] after success', engine.currentBackoffMs() === 10)
})()

// 2. Race-safe conditional remove: newer op enqueued mid-flight stays
section('Race-safe conditional remove')
;(async () => {
  const { engine, queue, dropbox } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  src.set(
    'rec-race',
    makeIdentityRecord({ id: 'rec-race', updatedAt: '2026-05-11T10:00:00.000Z' }),
  )
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'rec-race',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })

  dropbox._setUploadDelay(20)
  const drainPromise = engine.drainOnce()
  await new Promise((r) => setTimeout(r, 5))
  src.set(
    'rec-race',
    makeIdentityRecord({ id: 'rec-race', updatedAt: '2026-05-11T11:00:00.000Z' }),
  )
  src.fire({
    op: 'update',
    recordType: 'identity',
    recordId: 'rec-race',
    updatedAt: '2026-05-11T11:00:00.000Z',
  })
  ok('queue holds 1 op (coalesced) during race', queue.size() === 1)
  ok(
    'queue updatedAt advanced to T2 mid-flight',
    queue.peek().updatedAt === '2026-05-11T11:00:00.000Z',
  )

  const result = await drainPromise
  ok("first drain returns 'pushed'", result === 'pushed')
  // _buildPayload runs SYNC before the 5ms await, capturing the T1 snapshot.
  // Upload sleeps 20ms; during that sleep, the T2 update coalesces. After
  // upload of T1 completes, _conditionalRemove sees slot.updatedAt (T2) >
  // pushedUpdatedAt (T1) → leaves the queue. THIS is the race-safety guarantee.
  ok(
    'queue keeps the T2 op for next drain (race-safety)',
    queue.size() === 1 && queue.peek().updatedAt === '2026-05-11T11:00:00.000Z',
    `size=${queue.size()} peek=${JSON.stringify(queue.peek())}`,
  )

  const result2 = await engine.drainOnce()
  ok("second drain pushes T2 and returns 'pushed'", result2 === 'pushed')
  ok('queue empty after second drain', queue.size() === 0)
})()

// 3. RECORD_GONE: upsert for a record that's no longer local → skip
section('drainOnce: record gone locally')
;(async () => {
  const { engine, queue } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'rec-ghost',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  const warns = []
  engine.on('warn', (w) => warns.push(w))
  const r = await engine.drainOnce()
  ok("RECORD_GONE returns 'skipped'", r === 'skipped')
  ok('queue cleared', queue.size() === 0)
  ok(
    'warn emitted with reason=record-gone-dropped',
    warns.some((w) => w.reason === 'record-gone-dropped'),
  )
})()

// ---------- Async test scheduling -------------------------------------------
setTimeout(() => {
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures)
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    process.exit(1)
  }
  process.exit(0)
}, 200)
