// OZ Browser — IdentityManager remote-apply smoke test (D-3c-3a CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/identity-manager-sync.smoketest.js
//
// Cubre:
//   - applyRemoteUpsert: new id → creates locally, op='create'
//   - applyRemoteUpsert: existing id → updates locally, op='update'
//   - applyRemoteUpsert: id='default' → rejected (returns null)
//   - applyRemoteUpsert: invalid record / missing id → rejected
//   - applyRemoteUpsert: missing updatedAt → backfilled defensively
//   - applyRemoteUpsert: NEVER emits 'changed' (would loop the sync engine)
//   - applyRemoteUpsert: emits 'remote-applied' with payload
//   - applyRemoteUpsert: remote claim of isDefault is forced to false
//   - applyRemoteDelete: existing id → removes, op='delete'
//   - applyRemoteDelete: id='default' → rejected
//   - applyRemoteDelete: missing id → idempotent null
//   - applyRemoteDelete: NEVER emits 'changed'
//   - applyRemoteDelete: emits 'remote-applied' with deletedAt
//   - workspaceSyncHook is fired on create / delete
//   - throwing 'remote-applied' listener does NOT break the apply
//   - sessionCache is invalidated on apply delete

'use strict'

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ---------- Electron mock ---------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-imsync-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

function makeFakeSession(label) {
  return {
    __label: label,
    setUserAgent() {},
    cookies: { onChanged: { addListener() {} } },
  }
}

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    getAppPath: () => path.resolve(__dirname, '..'),
    on() {},
    whenReady: () => Promise.resolve(),
  },
  session: {
    defaultSession: makeFakeSession('default'),
    fromPartition: (partition) => {
      if (!fakeElectron.session.__partitionCache) {
        fakeElectron.session.__partitionCache = new Map()
      }
      const cache = fakeElectron.session.__partitionCache
      if (cache.has(partition)) return cache.get(partition)
      const ses = makeFakeSession(partition)
      cache.set(partition, ses)
      return ses
    },
  },
}

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

// ---------- Test runner -----------------------------------------------------

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

function freshIM() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  fakeElectron.session.__partitionCache = new Map()
  process.env.OZ_TIER = 'paid'

  delete require.cache[require.resolve('../browser/identity-manager.js')]
  delete require.cache[require.resolve('../browser/identity-manager-sync.js')]
  delete require.cache[require.resolve('../browser/logger.js')]

  const { IdentityManager } = require('../browser/identity-manager.js')
  const {
    applyRemoteUpsert,
    applyRemoteDelete,
  } = require('../browser/identity-manager-sync.js')
  return { IdentityManager, applyRemoteUpsert, applyRemoteDelete }
}

console.log('OZ Browser — identity-manager-sync (remote-apply) smoke test')

// 1. applyRemoteUpsert creates a new identity
section('applyRemoteUpsert: new id → create')
{
  const { IdentityManager, applyRemoteUpsert } = freshIM()
  const im = new IdentityManager()

  const changes = []
  const remoteApplied = []
  im.on('changed', (e) => changes.push(e))
  im.on('remote-applied', (e) => remoteApplied.push(e))

  const result = applyRemoteUpsert(im, {
    id: 'remote-new',
    name: 'New From Remote',
    color: '#ff0000',
    fingerprintSeed: 'remote-seed',
    workspaceId: 'general',
    locked: false,
    updatedAt: '2026-05-11T10:00:00.000Z',
    createdAt: 1715346000000,
  })

  ok("returns op='create'", result && result.op === 'create')
  ok('identity persisted', im.get('remote-new') !== null)
  ok(
    'local list includes remote record',
    im.list().some((i) => i.id === 'remote-new'),
  )
  ok('no changed emit (avoids push loop)', changes.length === 0)
  ok('1 remote-applied emit', remoteApplied.length === 1)
  ok('remote-applied op=create', remoteApplied[0].op === 'create')
  ok("remote-applied recordType='identity'", remoteApplied[0].recordType === 'identity')
  ok(
    'remote-applied identity carries name',
    remoteApplied[0].identity.name === 'New From Remote',
  )
}

// 2. applyRemoteUpsert updates an existing identity
section('applyRemoteUpsert: existing id → update')
{
  const { IdentityManager, applyRemoteUpsert } = freshIM()
  const im = new IdentityManager()
  const local = im.create({ name: 'Local Initial' })

  const changes = []
  im.on('changed', (e) => changes.push(e))

  applyRemoteUpsert(im, {
    id: local.id,
    name: 'Updated By Remote',
    color: '#00ff00',
    fingerprintSeed: local.fingerprintSeed,
    workspaceId: 'general',
    locked: false,
    updatedAt: '2026-05-11T11:00:00.000Z',
    createdAt: local.createdAt,
  })

  const after = im.get(local.id)
  ok('name updated', after.name === 'Updated By Remote')
  ok('color updated', after.color === '#00ff00')
  ok('updatedAt updated', after.updatedAt === '2026-05-11T11:00:00.000Z')
  ok("no 'changed' emit on remote update", changes.length === 0)
}

// 3. applyRemoteUpsert rejects 'default' identity
section('applyRemoteUpsert: refuses Default')
{
  const { IdentityManager, applyRemoteUpsert } = freshIM()
  const im = new IdentityManager()
  const defaultBefore = JSON.parse(JSON.stringify(im.get('default')))
  const result = applyRemoteUpsert(im, {
    id: 'default',
    name: 'Should Not Apply',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('returns null', result === null)
  const defaultAfter = im.get('default')
  ok('Default unchanged (name)', defaultAfter.name === defaultBefore.name)
  ok('Default unchanged (color)', defaultAfter.color === defaultBefore.color)
}

// 4. applyRemoteUpsert rejects invalid records
section('applyRemoteUpsert: validation')
{
  const { IdentityManager, applyRemoteUpsert } = freshIM()
  const im = new IdentityManager()
  ok('null record → null', applyRemoteUpsert(im, null) === null)
  ok('record without id → null', applyRemoteUpsert(im, { name: 'No ID' }) === null)
  ok('record with non-string id → null', applyRemoteUpsert(im, { id: 123 }) === null)
}

// 5. applyRemoteUpsert backfills missing updatedAt
section('applyRemoteUpsert: defensive updatedAt backfill')
{
  const { IdentityManager, applyRemoteUpsert } = freshIM()
  const im = new IdentityManager()
  applyRemoteUpsert(im, {
    id: 'no-ts',
    name: 'Sin Timestamp',
    color: '#aaa',
    fingerprintSeed: 'seed',
    workspaceId: 'general',
    // updatedAt missing
  })
  const applied = im.get('no-ts')
  ok(
    'updatedAt backfilled to a parseable ISO',
    typeof applied.updatedAt === 'string' && !Number.isNaN(Date.parse(applied.updatedAt)),
  )
  // Malformed updatedAt → backfilled too
  applyRemoteUpsert(im, {
    id: 'bad-ts',
    name: 'Mal',
    color: '#bbb',
    fingerprintSeed: 'seed',
    workspaceId: 'general',
    updatedAt: 'not-iso',
  })
  const applied2 = im.get('bad-ts')
  ok(
    'malformed updatedAt backfilled',
    typeof applied2.updatedAt === 'string' &&
      !Number.isNaN(Date.parse(applied2.updatedAt)),
  )
}

// 6. Remote claim of isDefault is forced to false
section('applyRemoteUpsert: never lets remote claim isDefault')
{
  const { IdentityManager, applyRemoteUpsert } = freshIM()
  const im = new IdentityManager()
  applyRemoteUpsert(im, {
    id: 'sneaky',
    name: 'Trying',
    color: '#fff',
    fingerprintSeed: 'seed',
    workspaceId: 'general',
    updatedAt: '2026-05-11T10:00:00.000Z',
    isDefault: true, // forced to false on apply
  })
  ok('remote isDefault=true is forced to false', im.get('sneaky').isDefault === false)
}

// 7. applyRemoteDelete removes an identity
section('applyRemoteDelete: existing id → delete')
{
  const { IdentityManager, applyRemoteDelete } = freshIM()
  const im = new IdentityManager()
  const created = im.create({ name: 'ToDel', workspaceId: 'ws-x' })

  const changes = []
  const remoteApplied = []
  im.on('changed', (e) => changes.push(e))
  im.on('remote-applied', (e) => remoteApplied.push(e))

  const result = applyRemoteDelete(im, created.id, '2026-05-11T12:00:00.000Z')
  ok("returns op='delete'", result && result.op === 'delete')
  ok('record gone locally', im.get(created.id) === null)
  ok("no 'changed' emit", changes.length === 0)
  ok('1 remote-applied emit', remoteApplied.length === 1)
  ok("remote-applied op='delete'", remoteApplied[0].op === 'delete')
  ok(
    'remote-applied carries deletedAt',
    remoteApplied[0].deletedAt === '2026-05-11T12:00:00.000Z',
  )
}

// 8. applyRemoteDelete idempotent
section('applyRemoteDelete: missing id → idempotent null')
{
  const { IdentityManager, applyRemoteDelete } = freshIM()
  const im = new IdentityManager()
  const result = applyRemoteDelete(im, 'never-existed', '2026-05-11T12:00:00.000Z')
  ok('returns null', result === null)
}

// 9. applyRemoteDelete rejects 'default'
section('applyRemoteDelete: refuses Default')
{
  const { IdentityManager, applyRemoteDelete } = freshIM()
  const im = new IdentityManager()
  const result = applyRemoteDelete(im, 'default')
  ok('returns null', result === null)
  ok('Default still exists', im.get('default') !== null)
}

// 10. applyRemoteDelete invalid recordId
section('applyRemoteDelete: validation')
{
  const { IdentityManager, applyRemoteDelete } = freshIM()
  const im = new IdentityManager()
  ok('undefined recordId → null', applyRemoteDelete(im, undefined) === null)
  ok('empty string → null', applyRemoteDelete(im, '') === null)
  ok('non-string → null', applyRemoteDelete(im, 42) === null)
}

// 11. workspaceSyncHook fires on apply create / delete
section('workspaceSyncHook fires on remote apply')
{
  const { IdentityManager, applyRemoteUpsert, applyRemoteDelete } = freshIM()
  const im = new IdentityManager()
  const calls = []
  im.setWorkspaceSyncHook((op, id, from, to) => calls.push({ op, id, from, to }))

  applyRemoteUpsert(im, {
    id: 'wsh-new',
    name: 'WSH',
    color: '#aaa',
    fingerprintSeed: 'seed',
    workspaceId: 'ws-remote',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  ok(
    "create fires workspaceSyncHook 'add'",
    calls.some((c) => c.op === 'add' && c.id === 'wsh-new' && c.to === 'ws-remote'),
  )

  applyRemoteDelete(im, 'wsh-new', '2026-05-11T11:00:00.000Z')
  ok(
    "delete fires workspaceSyncHook 'remove'",
    calls.some((c) => c.op === 'remove' && c.id === 'wsh-new' && c.from === 'ws-remote'),
  )
}

// 12. Throwing remote-applied listener does NOT break the apply
section('throwing remote-applied listener is isolated')
{
  const { IdentityManager, applyRemoteUpsert } = freshIM()
  const im = new IdentityManager()
  im.on('remote-applied', () => {
    throw new Error('intentional listener fault')
  })
  let result
  try {
    result = applyRemoteUpsert(im, {
      id: 'rec-thrower',
      name: 'Survives Throw',
      color: '#aaa',
      fingerprintSeed: 'seed',
      workspaceId: 'general',
      updatedAt: '2026-05-11T10:00:00.000Z',
    })
  } catch (e) {
    result = { _err: e.message }
  }
  ok('apply still returned a result', result && result.op === 'create')
  ok('apply persisted state despite listener throw', im.get('rec-thrower') !== null)
}

// 13. sessionCache is invalidated on apply delete
section('sessionCache invalidation on apply delete')
{
  const { IdentityManager, applyRemoteDelete } = freshIM()
  const im = new IdentityManager()
  const created = im.create({ name: 'WithSession' })
  // Force the sessionCache to populate
  im.getSession(created.id)
  ok('sessionCache has the id before delete', im.sessionCache.has(created.id))
  applyRemoteDelete(im, created.id, '2026-05-11T12:00:00.000Z')
  ok('sessionCache cleared after delete', !im.sessionCache.has(created.id))
}

// ---------- Cleanup --------------------------------------------------------

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
