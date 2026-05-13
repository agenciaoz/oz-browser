// OZ Browser — Sync Queue smoke test (D-3b CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-queue.smoketest.js
//
// Cubre:
//   - enqueue → save → load round-trip
//   - FIFO order preserved across reload
//   - coalesce: re-enqueue same (recordType,recordId) replaces + moves to end
//   - peek does NOT mutate; dequeue does
//   - remove(rt, rid) by key
//   - clear() drops everything
//   - schema mismatch → start fresh + warn
//   - corrupt JSON → start fresh + warn
//   - invalid op shape → throws SyncQueueError
//   - upsert without updatedAt → throws
//   - delete without deletedAt → throws
//   - upsert with deletedAt → throws
//   - has() correct
//   - events: 'enqueued' (coalesced flag), 'dequeued', 'removed', 'cleared', 'warn'

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  SyncQueue,
  SyncQueueError,
  SCHEMA_VERSION,
  MAX_QUEUE_SIZE,
} = require('../browser/sync-queue')

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

function tmpQueueFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-syncq-'))
  return path.join(dir, 'sync-queue.json')
}

const upsert = (
  recordId,
  recordType = 'identity',
  updatedAt = '2026-05-11T10:00:00.000Z',
) => ({
  op: 'upsert',
  recordType,
  recordId,
  updatedAt,
})

const tombstone = (
  recordId,
  recordType = 'identity',
  deletedAt = '2026-05-11T10:00:00.000Z',
) => ({
  op: 'delete',
  recordType,
  recordId,
  deletedAt,
})

console.log('OZ Browser — sync-queue smoke test')

// 1. Round-trip
section('Round-trip enqueue → save → load')
{
  const fp = tmpQueueFile()
  const q1 = new SyncQueue({ filePath: fp }).load()
  ok('starts empty', q1.size() === 0)
  q1.enqueue(upsert('a'))
  q1.enqueue(upsert('b'))
  q1.enqueue(tombstone('c'))
  ok('size === 3 after enqueue', q1.size() === 3)

  const q2 = new SyncQueue({ filePath: fp }).load()
  ok('reload size === 3', q2.size() === 3)
  const list = q2.list()
  ok('reload FIFO order [a, b, c]', list.map((o) => o.recordId).join(',') === 'a,b,c')
  ok('reload preserves op types', list[2].op === 'delete' && list[0].op === 'upsert')
  ok('reload preserves updatedAt', list[0].updatedAt === '2026-05-11T10:00:00.000Z')
  ok('reload preserves deletedAt', list[2].deletedAt === '2026-05-11T10:00:00.000Z')
}

// 2. FIFO peek / dequeue
section('peek + dequeue (FIFO)')
{
  const fp = tmpQueueFile()
  const q = new SyncQueue({ filePath: fp }).load()
  q.enqueue(upsert('a'))
  q.enqueue(upsert('b'))
  q.enqueue(upsert('c'))

  const peek1 = q.peek()
  ok('peek returns first op (a)', peek1.recordId === 'a')
  ok('peek does not mutate size', q.size() === 3)

  // Verify peek returns a copy — mutating it shouldn't affect state.
  peek1.recordId = 'MUTATED'
  ok('peek returns a copy (mutating is harmless)', q.peek().recordId === 'a')

  const d1 = q.dequeue()
  ok('dequeue returns a', d1.recordId === 'a')
  ok('size === 2 after dequeue', q.size() === 2)
  ok('next peek is b', q.peek().recordId === 'b')

  q.dequeue()
  q.dequeue()
  ok('empty after draining', q.size() === 0)
  ok('peek on empty returns null', q.peek() === null)
  ok('dequeue on empty returns null', q.dequeue() === null)
}

// 3. Coalesce: re-enqueue same key
section('Coalesce: re-enqueue same (recordType, recordId)')
{
  const fp = tmpQueueFile()
  const q = new SyncQueue({ filePath: fp }).load()
  q.enqueue(upsert('a', 'identity', '2026-05-11T10:00:00.000Z'))
  q.enqueue(upsert('b'))
  // Re-enqueue a with newer timestamp
  const r = q.enqueue(upsert('a', 'identity', '2026-05-11T11:00:00.000Z'))
  ok('second enqueue reports coalesced=true', r.coalesced === true)
  ok('size still 2 (deduped)', q.size() === 2)

  const list = q.list()
  ok(
    'FIFO order is now [b, a] (a moved to end)',
    list.map((o) => o.recordId).join(',') === 'b,a',
  )
  ok('a carries the NEW updatedAt', list[1].updatedAt === '2026-05-11T11:00:00.000Z')

  // upsert then delete on same record → delete supersedes (same coalesce
  // logic, just replaces the upsert with a delete).
  q.enqueue(tombstone('b', 'identity', '2026-05-11T12:00:00.000Z'))
  const list2 = q.list()
  const bOp = list2.find((o) => o.recordId === 'b')
  ok('upsert→delete coalesces to delete', bOp && bOp.op === 'delete')
  ok('delete carries deletedAt', bOp && bOp.deletedAt === '2026-05-11T12:00:00.000Z')

  // delete then upsert on same record → resurrection (upsert supersedes).
  q.enqueue(upsert('b', 'identity', '2026-05-11T13:00:00.000Z'))
  const list3 = q.list()
  const bOp2 = list3.find((o) => o.recordId === 'b')
  ok('delete→upsert coalesces to upsert (resurrection)', bOp2 && bOp2.op === 'upsert')
}

// 4. Different recordType + same recordId → distinct slots
section('Different recordType → distinct slots')
{
  const q = new SyncQueue({ filePath: tmpQueueFile() }).load()
  q.enqueue(upsert('shared', 'identity'))
  q.enqueue(upsert('shared', 'workspace'))
  ok('size === 2 (recordType differentiates)', q.size() === 2)
  ok('has(identity, shared)', q.has('identity', 'shared'))
  ok('has(workspace, shared)', q.has('workspace', 'shared'))
}

// 5. remove(rt, rid)
section('remove(recordType, recordId)')
{
  const q = new SyncQueue({ filePath: tmpQueueFile() }).load()
  q.enqueue(upsert('a'))
  q.enqueue(upsert('b'))
  q.enqueue(upsert('c'))

  ok('remove returns true on hit', q.remove('identity', 'b') === true)
  ok('size === 2 after remove', q.size() === 2)
  ok('has(b) now false', !q.has('identity', 'b'))
  ok(
    'FIFO preserved: [a, c]',
    q
      .list()
      .map((o) => o.recordId)
      .join(',') === 'a,c',
  )
  ok('remove on miss returns false', q.remove('identity', 'nope') === false)
  ok('remove with wrong recordType returns false', q.remove('workspace', 'a') === false)
}

// 6. clear()
section('clear()')
{
  const q = new SyncQueue({ filePath: tmpQueueFile() }).load()
  q.enqueue(upsert('a'))
  q.enqueue(upsert('b'))
  let clearedEvent = null
  q.on('cleared', (e) => (clearedEvent = e))
  q.clear()
  ok('size === 0 after clear', q.size() === 0)
  ok(
    'cleared event fired with droppedCount=2',
    clearedEvent && clearedEvent.droppedCount === 2,
  )
}

// 7. Schema mismatch on load
section('Schema mismatch / corrupt JSON on load')
{
  const fp = tmpQueueFile()
  fs.writeFileSync(fp, JSON.stringify({ schemaVersion: 99, queue: [] }))
  const q = new SyncQueue({ filePath: fp })
  const warns = []
  q.on('warn', (w) => warns.push(w))
  q.load()
  ok('starts fresh on schema mismatch', q.size() === 0)
  ok(
    'emits warn with reason=schema-mismatch',
    warns.some((w) => w.reason === 'schema-mismatch'),
  )
}
{
  const fp = tmpQueueFile()
  fs.writeFileSync(fp, '{this is not json}')
  const q = new SyncQueue({ filePath: fp })
  const warns = []
  q.on('warn', (w) => warns.push(w))
  q.load()
  ok('starts fresh on parse failure', q.size() === 0)
  ok(
    'emits warn with reason=parse-failed',
    warns.some((w) => w.reason === 'parse-failed'),
  )
}
{
  // Valid schema + malformed op inside queue — skip op + load the rest.
  const fp = tmpQueueFile()
  fs.writeFileSync(
    fp,
    JSON.stringify({
      schemaVersion: 1,
      queue: [
        upsert('a'),
        { op: 'wat', recordType: 'identity', recordId: 'malformed' },
        upsert('c'),
      ],
    }),
  )
  const q = new SyncQueue({ filePath: fp })
  const warns = []
  q.on('warn', (w) => warns.push(w))
  q.load()
  ok('loads valid ops, skips malformed', q.size() === 2)
  ok(
    'emits warn with reason=invalid-op-skipped',
    warns.some((w) => w.reason === 'invalid-op-skipped'),
  )
  ok(
    'kept ops are a + c',
    q
      .list()
      .map((o) => o.recordId)
      .join(',') === 'a,c',
  )
}

// 8. Validation: invalid op shapes throw
section('Validation: invalid ops')
{
  const q = new SyncQueue({ filePath: tmpQueueFile() }).load()
  throwsWithCode('null op → BAD_OP', () => q.enqueue(null), 'BAD_OP')
  throwsWithCode(
    'unknown op type → BAD_OP_TYPE',
    () => q.enqueue({ op: 'wat', recordType: 'identity', recordId: 'a' }),
    'BAD_OP_TYPE',
  )
  throwsWithCode(
    'missing recordType → BAD_RECORD_TYPE',
    () =>
      q.enqueue({
        op: 'upsert',
        recordType: '',
        recordId: 'a',
        updatedAt: '2026-05-11T10:00:00.000Z',
      }),
    'BAD_RECORD_TYPE',
  )
  throwsWithCode(
    'missing recordId → BAD_RECORD_ID',
    () =>
      q.enqueue({
        op: 'upsert',
        recordType: 'identity',
        recordId: '',
        updatedAt: '2026-05-11T10:00:00.000Z',
      }),
    'BAD_RECORD_ID',
  )
  throwsWithCode(
    'upsert without updatedAt → BAD_UPDATED_AT',
    () => q.enqueue({ op: 'upsert', recordType: 'identity', recordId: 'a' }),
    'BAD_UPDATED_AT',
  )
  throwsWithCode(
    'upsert with non-ISO updatedAt → BAD_UPDATED_AT',
    () =>
      q.enqueue({
        op: 'upsert',
        recordType: 'identity',
        recordId: 'a',
        updatedAt: 'not-iso',
      }),
    'BAD_UPDATED_AT',
  )
  throwsWithCode(
    'delete without deletedAt → BAD_DELETED_AT',
    () => q.enqueue({ op: 'delete', recordType: 'identity', recordId: 'a' }),
    'BAD_DELETED_AT',
  )
  throwsWithCode(
    'upsert with deletedAt → UPSERT_WITH_DELETED_AT',
    () =>
      q.enqueue({
        op: 'upsert',
        recordType: 'identity',
        recordId: 'a',
        updatedAt: '2026-05-11T10:00:00.000Z',
        deletedAt: '2026-05-11T10:00:00.000Z',
      }),
    'UPSERT_WITH_DELETED_AT',
  )
  throwsWithCode(
    'delete with updatedAt → DELETE_WITH_UPDATED_AT',
    () =>
      q.enqueue({
        op: 'delete',
        recordType: 'identity',
        recordId: 'a',
        deletedAt: '2026-05-11T10:00:00.000Z',
        updatedAt: '2026-05-11T10:00:00.000Z',
      }),
    'DELETE_WITH_UPDATED_AT',
  )
}

// 9. Constructor + bad args
section('Constructor + bad args')
{
  throwsWithCode('no filePath → BAD_ARG', () => new SyncQueue({}), 'BAD_ARG')
  throwsWithCode(
    'non-string filePath → BAD_ARG',
    () => new SyncQueue({ filePath: 123 }),
    'BAD_ARG',
  )
}

// 10. Events: enqueued / dequeued / removed / cleared
section('Events: enqueued / dequeued / removed')
{
  const q = new SyncQueue({ filePath: tmpQueueFile() }).load()
  const events = { enqueued: [], dequeued: [], removed: [] }
  q.on('enqueued', (e) => events.enqueued.push(e))
  q.on('dequeued', (e) => events.dequeued.push(e))
  q.on('removed', (e) => events.removed.push(e))

  q.enqueue(upsert('a'))
  ok('enqueued event fired (1)', events.enqueued.length === 1)
  ok('enqueued.coalesced === false on new key', events.enqueued[0].coalesced === false)
  q.enqueue(upsert('a', 'identity', '2026-05-11T11:00:00.000Z'))
  ok('enqueued.coalesced === true on existing key', events.enqueued[1].coalesced === true)

  q.dequeue()
  ok(
    'dequeued event fired',
    events.dequeued.length === 1 && events.dequeued[0].op.recordId === 'a',
  )

  q.enqueue(upsert('b'))
  q.remove('identity', 'b')
  ok(
    'removed event fired',
    events.removed.length === 1 && events.removed[0].op.recordId === 'b',
  )
}

// 11. Sanity: constants + persistence creates dir
section('Sanity constants + dir creation')
{
  ok('SCHEMA_VERSION === 1', SCHEMA_VERSION === 1)
  ok('MAX_QUEUE_SIZE > 0', MAX_QUEUE_SIZE > 0 && MAX_QUEUE_SIZE >= 10_000)
  // mkdir on save for non-existent dir
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-syncq-dir-'))
  const nested = path.join(dir, 'a', 'b', 'sync-queue.json')
  const q = new SyncQueue({ filePath: nested }).load()
  q.enqueue(upsert('x'))
  ok('saved file exists at nested path', fs.existsSync(nested))
}

// 12. Error class shape
section('Error class shape')
{
  let caught
  try {
    new SyncQueue({ filePath: tmpQueueFile() }).load().enqueue({})
  } catch (e) {
    caught = e
  }
  ok('thrown error is SyncQueueError', caught instanceof SyncQueueError)
  ok('thrown error has .code', typeof caught.code === 'string')
  ok('thrown error has .name', caught.name === 'SyncQueueError')
}

// ---------- Summary ---------------------------------------------------------
console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
