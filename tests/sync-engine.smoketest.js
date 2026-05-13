// OZ Browser — Sync Engine smoke test (D-3c-1 CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-engine.smoketest.js
//
// Cubre:
//   - registerSource installs 'changed' listener
//   - 'changed' op=create / update → queue.enqueue(upsert)
//   - 'changed' op=delete → queue.enqueue(delete)
//   - drainOnce on empty → 'empty'
//   - drainOnce vault locked → 'vault-locked' (no upload)
//   - drainOnce dropbox unauthenticated → 'unauthenticated' (no upload)
//   - drainOnce happy path → uploads encoded record to Dropbox + removes from queue
//   - drainOnce on delete → uploads tombstone (deleted:true, no body) + removes
//   - drainOnce on upload failure → backoff escalates, op stays in queue
//   - drainOnce on success → backoff resets to schedule[0]
//   - race-safe conditional remove: queue gets newer op mid-flight → not removed
//   - drainOnce skips upsert when record gone locally (RECORD_GONE)
//   - end-to-end: IdentityManager.create() → engine pushes encoded record →
//     download + decode round-trips back to the same identity
//   - unknown 'changed' op → warn, no enqueue
//   - 'changed' without updatedAt → warn, no enqueue
//   - registerSource duplicate → throws SOURCE_DUP
//   - registerSource bad args → throws BAD_SOURCE
//   - stop() detaches listener (no double-emit)
//   - currentBackoffMs progression

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const { SyncQueue } = require('../browser/sync-queue')
const {
  SyncEngine,
  SyncEngineError,
  DEFAULT_BACKOFF_MS,
} = require('../browser/sync-engine')
const { decodeRecord } = require('../browser/sync-record-store')

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
    caught
      ? `threw code=${caught.code} message=${caught.message.slice(0, 80)}`
      : 'did not throw',
  )
}

function section(name) {
  console.log(`\n— ${name} —`)
}

// ---------- Test doubles ----------------------------------------------------

function makeFakeVault({ unlocked = true } = {}) {
  const key = crypto.randomBytes(32)
  const state = { unlocked, key }
  return {
    get isUnlocked() {
      return state.unlocked
    },
    getMasterKey() {
      return state.unlocked ? state.key : null
    },
    _setUnlocked(v) {
      state.unlocked = v
    },
    _key: () => state.key,
  }
}

function makeFakeDropbox({ authenticated = true } = {}) {
  const store = new Map() // path → Buffer
  const events = { uploads: [], deletes: [] }
  const state = { authenticated, nextError: null, uploadDelayMs: 0 }
  return {
    isAuthenticated() {
      return state.authenticated
    },
    async upload(p, buf) {
      events.uploads.push({ path: p, size: buf.length })
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
    async download(p) {
      const b = store.get(p)
      if (!b) {
        const e = new Error('not_found')
        e.code = 'NOT_FOUND'
        throw e
      }
      return b
    },
    async delete(p) {
      events.deletes.push({ path: p })
      store.delete(p)
    },
    _store: store,
    _events: events,
    _setAuthenticated(v) {
      state.authenticated = v
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
    _bufferAt(p) {
      return store.get(p) || null
    },
  }
}

function makeFakeIdentitySource() {
  const emitter = new EventEmitter()
  const records = new Map() // recordId → record
  return {
    emitter,
    records,
    fetchRecord(recordId) {
      return records.get(recordId) || null
    },
    set(recordId, record) {
      records.set(recordId, record)
    },
    remove(recordId) {
      records.delete(recordId)
    },
    fire(payload) {
      emitter.emit('changed', payload)
    },
  }
}

function tmpQueueFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-syncengine-'))
  return path.join(dir, 'sync-queue.json')
}

function makeEngine(overrides = {}) {
  const vault = overrides.vault || makeFakeVault()
  const dropbox = overrides.dropbox || makeFakeDropbox()
  const queue = overrides.queue || new SyncQueue({ filePath: tmpQueueFile() }).load()
  const engine = new SyncEngine({
    vault,
    dropbox,
    queue,
    deviceFolder: overrides.deviceFolder || 'mac-aaaa1111',
    appFolder: overrides.appFolder || 'sync',
    backoffSchedule: overrides.backoffSchedule || [10, 20, 40, 80],
    idleWaitMs: overrides.idleWaitMs || 10,
    // Suppress real timers by default — tests drive drainOnce() directly.
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

console.log('OZ Browser — sync-engine smoke test')

// 1. registerSource installs listener; create/update event enqueues upsert
section('registerSource + changed → enqueue')
{
  const { engine, queue } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })

  src.set('rec-1', makeIdentityRecord({ id: 'rec-1' }))
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'rec-1',
    record: src.records.get('rec-1'),
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('queue size 1 after create event', queue.size() === 1)
  ok('queue op is upsert', queue.peek().op === 'upsert')
  ok('queue recordId matches', queue.peek().recordId === 'rec-1')
  ok(
    'queue updatedAt matches event',
    queue.peek().updatedAt === '2026-05-11T10:00:00.000Z',
  )

  src.fire({
    op: 'update',
    recordType: 'identity',
    recordId: 'rec-1',
    record: src.records.get('rec-1'),
    updatedAt: '2026-05-11T11:00:00.000Z',
  })
  ok('size still 1 (coalesced)', queue.size() === 1)
  ok(
    'queue updatedAt advanced to newer event',
    queue.peek().updatedAt === '2026-05-11T11:00:00.000Z',
  )
}

// 2. delete event enqueues tombstone op
section('delete event → enqueue tombstone op')
{
  const { engine, queue } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  src.fire({
    op: 'delete',
    recordType: 'identity',
    recordId: 'rec-gone',
    deletedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('queue size 1', queue.size() === 1)
  ok('queue op is delete', queue.peek().op === 'delete')
  ok(
    'queue deletedAt matches event',
    queue.peek().deletedAt === '2026-05-11T10:00:00.000Z',
  )
}

// 3. drainOnce on empty → 'empty'
section('drainOnce: empty queue')
;(async () => {
  const { engine } = makeEngine()
  const result = await engine.drainOnce()
  ok("drainOnce on empty queue returns 'empty'", result === 'empty')
})()

// 4. vault-locked / unauthenticated pause
section('drainOnce: vault locked / unauthenticated')
;(async () => {
  const vault = makeFakeVault({ unlocked: false })
  const { engine, queue } = makeEngine({ vault })
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  src.set('rec-1', makeIdentityRecord({ id: 'rec-1' }))
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'rec-1',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('queue has 1 op while vault locked', queue.size() === 1)
  const result = await engine.drainOnce()
  ok("vault locked → 'vault-locked'", result === 'vault-locked')
  ok('op still in queue (not dropped)', queue.size() === 1)
})()
;(async () => {
  const dropbox = makeFakeDropbox({ authenticated: false })
  const { engine, queue } = makeEngine({ dropbox })
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  src.set('rec-1', makeIdentityRecord({ id: 'rec-1' }))
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'rec-1',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  const result = await engine.drainOnce()
  ok("unauthenticated → 'unauthenticated'", result === 'unauthenticated')
  ok('op still in queue', queue.size() === 1)
})()

// 5. Happy path: drainOnce uploads + removes
section('drainOnce: happy path')
;(async () => {
  const { engine, queue, dropbox, vault } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  const rec = makeIdentityRecord({ id: 'rec-happy' })
  src.set('rec-happy', rec)
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'rec-happy',
    updatedAt: rec.updatedAt,
  })

  const pushedEvents = []
  engine.on('pushed', (e) => pushedEvents.push(e))

  const result = await engine.drainOnce()
  ok("drainOnce returns 'pushed'", result === 'pushed')
  ok('pushed event fired once', pushedEvents.length === 1)
  ok(
    'dropbox uploaded to /sync/identitys/rec-happy.json.enc',
    dropbox._hasPath('/sync/identitys/rec-happy.json.enc'),
  )
  ok('queue empty after successful push', queue.size() === 0)

  // Round-trip via decodeRecord
  const buf = dropbox._bufferAt('/sync/identitys/rec-happy.json.enc')
  const { header, body } = decodeRecord(vault._key(), buf)
  ok('decoded header.recordId matches', header.recordId === 'rec-happy')
  ok('decoded header.deviceFolder matches', header.deviceFolder === 'mac-aaaa1111')
  ok('decoded header.deleted === false', header.deleted === false)
  ok('decoded body.name matches', body.name === rec.name)
  ok('decoded body.fingerprintSeed matches', body.fingerprintSeed === rec.fingerprintSeed)
})()

// 6. Delete drain → tombstone uploaded
section('drainOnce: delete uploads tombstone')
;(async () => {
  const { engine, dropbox, vault } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  src.fire({
    op: 'delete',
    recordType: 'identity',
    recordId: 'rec-tombstone',
    deletedAt: '2026-05-11T10:00:00.000Z',
  })

  const result = await engine.drainOnce()
  ok("delete drains to 'pushed'", result === 'pushed')
  ok(
    'tombstone uploaded at expected path',
    dropbox._hasPath('/sync/identitys/rec-tombstone.json.enc'),
  )
  const buf = dropbox._bufferAt('/sync/identitys/rec-tombstone.json.enc')
  const { header, body } = decodeRecord(vault._key(), buf)
  ok('decoded header.deleted === true', header.deleted === true)
  ok(
    'decoded header.deletedAt preserved',
    header.deletedAt === '2026-05-11T10:00:00.000Z',
  )
  ok('decoded body === null (tombstone)', body === null)
})()

// Backoff escalation, race-safe conditional remove, and RECORD_GONE handling
// live in tests/sync-engine-resilience.smoketest.js (split per ADR 0005 LOC rule).

// 10. Validation: unknown op → warn, no enqueue
section('Validation: unknown op / missing fields')
{
  const { engine, queue } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  const warns = []
  engine.on('warn', (w) => warns.push(w))
  src.fire({ op: 'wat', recordType: 'identity', recordId: 'rec-x' })
  ok('unknown op does not enqueue', queue.size() === 0)
  ok(
    'unknown op emits warn',
    warns.some((w) => w.reason === 'unknown-op'),
  )

  // Missing updatedAt
  warns.length = 0
  src.fire({ op: 'create', recordType: 'identity', recordId: 'rec-y' })
  ok('create without updatedAt does not enqueue', queue.size() === 0)
  ok(
    'create without updatedAt emits warn',
    warns.some((w) => w.reason === 'changed-missing-updated-at'),
  )

  // Missing deletedAt
  warns.length = 0
  src.fire({ op: 'delete', recordType: 'identity', recordId: 'rec-z' })
  ok('delete without deletedAt does not enqueue', queue.size() === 0)
  ok(
    'delete without deletedAt emits warn',
    warns.some((w) => w.reason === 'delete-missing-deleted-at'),
  )

  // Event without recordId → silently dropped (defensive)
  warns.length = 0
  src.fire({
    op: 'create',
    recordType: 'identity',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('event without recordId is silently ignored', queue.size() === 0)
}

// 11. registerSource errors
section('registerSource validation')
{
  const { engine } = makeEngine()
  throwsWithCode(
    'missing recordType → BAD_SOURCE',
    () => engine.registerSource({ manager: new EventEmitter(), fetchRecord: () => null }),
    'BAD_SOURCE',
  )
  throwsWithCode(
    'bad manager → BAD_SOURCE',
    () =>
      engine.registerSource({
        recordType: 'identity',
        manager: {},
        fetchRecord: () => null,
      }),
    'BAD_SOURCE',
  )
  throwsWithCode(
    'bad fetchRecord → BAD_SOURCE',
    () =>
      engine.registerSource({
        recordType: 'identity',
        manager: new EventEmitter(),
        fetchRecord: 'not-a-fn',
      }),
    'BAD_SOURCE',
  )

  engine.registerSource({
    recordType: 'identity',
    manager: new EventEmitter(),
    fetchRecord: () => null,
  })
  throwsWithCode(
    'duplicate recordType → SOURCE_DUP',
    () =>
      engine.registerSource({
        recordType: 'identity',
        manager: new EventEmitter(),
        fetchRecord: () => null,
      }),
    'SOURCE_DUP',
  )
}

// 12. Constructor errors
section('Constructor validation')
{
  const dropbox = makeFakeDropbox()
  const vault = makeFakeVault()
  const queue = new SyncQueue({ filePath: tmpQueueFile() }).load()
  throwsWithCode(
    'missing dropbox → BAD_ARG',
    () => new SyncEngine({ vault, queue, deviceFolder: 'mac-aa' }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing vault → BAD_ARG',
    () => new SyncEngine({ dropbox, queue, deviceFolder: 'mac-aa' }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing queue → BAD_ARG',
    () => new SyncEngine({ dropbox, vault, deviceFolder: 'mac-aa' }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing deviceFolder → BAD_ARG',
    () => new SyncEngine({ dropbox, vault, queue }),
    'BAD_ARG',
  )
}

// 13. stop() detaches listeners
section('stop() detaches listeners')
{
  const { engine, queue } = makeEngine()
  const src = makeFakeIdentitySource()
  engine.registerSource({
    recordType: 'identity',
    manager: src.emitter,
    fetchRecord: src.fetchRecord,
  })
  // start so stop has something to clean up
  engine.start()
  engine.stop()
  // Fire after stop — should not enqueue.
  src.set('post-stop', makeIdentityRecord({ id: 'post-stop' }))
  src.fire({
    op: 'create',
    recordType: 'identity',
    recordId: 'post-stop',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('post-stop event does not enqueue', queue.size() === 0)
}

// 14. Sanity: SyncEngineError + constants
section('Sanity constants')
{
  ok(
    'DEFAULT_BACKOFF_MS is non-empty array',
    Array.isArray(DEFAULT_BACKOFF_MS) && DEFAULT_BACKOFF_MS.length > 0,
  )
  ok('SyncEngineError exported', typeof SyncEngineError === 'function')
}

// ---------- Async test scheduling -------------------------------------------
// The async sections above kicked off promises that race the synchronous
// summary print below. Wait for the event loop to drain before reporting.

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
