// OZ Browser — Sync Setup smoke test (D-3c-3b CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-setup.smoketest.js
//
// Cubre:
//   - setupSync constructor validation
//   - Local IM create → engine queue.enqueue → drainOnce → dropbox.upload
//   - Local IM remove → engine queue.enqueue tombstone → drainOnce
//   - Remote upload → puller.pullOnce → 'remote-apply' upsert → IM has it
//   - Remote tombstone → puller.pullOnce → 'remote-apply' delete → IM gone
//   - Self-uploads on Dropbox are NOT re-applied locally (deviceFolder match)
//   - Round-trip: local create + drain + pull from another device's view
//   - start() / stop() lifecycle
//   - pullNow() manual trigger
//   - applyRemote does NOT trigger push (no infinite loop)

'use strict'

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')

// ---------- Electron mock ---------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-setup-'))
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

const MASTER_KEY = crypto.randomBytes(32)

function makeFakeVault() {
  return {
    isUnlocked: true,
    getMasterKey() {
      return MASTER_KEY
    },
    _key: () => MASTER_KEY,
  }
}

function makeFakeDropbox() {
  const store = new Map() // path → Buffer
  const folderEntries = new Map() // path → entries[]
  let nextCursor = 1
  return {
    isAuthenticated() {
      return true
    },
    async upload(p, buf) {
      store.set(p, Buffer.from(buf))
      // Auto-add to the parent folder's listing so subsequent listFolder
      // sees it. Realistic Dropbox behavior.
      const dir = p.split('/').slice(0, -1).join('/')
      if (!folderEntries.has(dir)) folderEntries.set(dir, [])
      const list = folderEntries.get(dir)
      if (!list.find((e) => e.pathDisplay === p)) {
        list.push({
          name: p.split('/').pop(),
          pathDisplay: p,
          pathLower: p.toLowerCase(),
          size: buf.length,
          serverModified: new Date().toISOString(),
          isFolder: false,
          isDeleted: false,
        })
      }
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
    async listFolder(p) {
      const entries = folderEntries.get(p) || []
      return { entries: entries.slice(), cursor: `c-${nextCursor++}`, hasMore: false }
    },
    async listFolderContinue() {
      // Tests don't exercise this path beyond the cold-start; return empty.
      return { entries: [], cursor: `c-${nextCursor++}`, hasMore: false }
    },
    async delete(p) {
      store.delete(p)
    },
    _store: store,
    _setFolderEntries(p, entries) {
      folderEntries.set(p, entries)
    },
    _hasPath(p) {
      return store.has(p)
    },
    _bufferAt(p) {
      return store.get(p) || null
    },
  }
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
  delete require.cache[require.resolve('../browser/sync-queue.js')]
  delete require.cache[require.resolve('../browser/sync-engine.js')]
  delete require.cache[require.resolve('../browser/sync-pull.js')]
  delete require.cache[require.resolve('../browser/sync-setup.js')]
  delete require.cache[require.resolve('../browser/logger.js')]

  const { IdentityManager } = require('../browser/identity-manager.js')
  const { setupSync, SyncSetupError } = require('../browser/sync-setup.js')
  const { encodeRecord } = require('../browser/sync-record-store')
  return { IdentityManager, setupSync, SyncSetupError, encodeRecord }
}

function makeSetup(overrides = {}) {
  const { IdentityManager, setupSync, encodeRecord } = freshIM()
  const im = new IdentityManager()
  const vault = overrides.vault || makeFakeVault()
  const dropbox = overrides.dropbox || makeFakeDropbox()
  const setup = setupSync({
    vault,
    dropbox,
    identityManager: im,
    userDataDir: TEST_USERDATA,
    deviceFolder: overrides.deviceFolder || 'mac-aaaa1111',
    // No real schedulers — tests drive drainOnce / pullNow manually.
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })
  return { im, vault, dropbox, setup, encodeRecord }
}

console.log('OZ Browser — sync-setup smoke test')

// 1. Constructor validation
section('Constructor validation')
{
  const { setupSync } = freshIM()
  const vault = makeFakeVault()
  const dropbox = makeFakeDropbox()
  const im = new (freshIM().IdentityManager)()
  throwsWithCode(
    'missing vault → BAD_ARG',
    () =>
      setupSync({
        dropbox,
        identityManager: im,
        userDataDir: TEST_USERDATA,
        deviceFolder: 'mac-aa',
      }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing dropbox → BAD_ARG',
    () =>
      setupSync({
        vault,
        identityManager: im,
        userDataDir: TEST_USERDATA,
        deviceFolder: 'mac-aa',
      }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing identityManager → BAD_ARG',
    () =>
      setupSync({
        vault,
        dropbox,
        userDataDir: TEST_USERDATA,
        deviceFolder: 'mac-aa',
      }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing userDataDir → BAD_ARG',
    () =>
      setupSync({
        vault,
        dropbox,
        identityManager: im,
        deviceFolder: 'mac-aa',
      }),
    'BAD_ARG',
  )
  throwsWithCode(
    'missing deviceFolder → BAD_ARG',
    () =>
      setupSync({
        vault,
        dropbox,
        identityManager: im,
        userDataDir: TEST_USERDATA,
      }),
    'BAD_ARG',
  )
}

// 2. Local create → drain → uploaded to Dropbox
section('Local IM create → engine push')
;(async () => {
  const { im, dropbox, setup } = makeSetup()
  const created = im.create({ name: 'PushTest' })
  ok('queue has 1 op after local create', setup.queue.size() === 1)
  const r = await setup.engine.drainOnce()
  ok("drainOnce returns 'pushed'", r === 'pushed')
  ok(
    'dropbox has the encrypted record at the expected path',
    dropbox._hasPath(`/sync/identitys/${created.id}.json.enc`),
  )
  ok('queue empty after push', setup.queue.size() === 0)
})()

// 3. Local remove → tombstone uploaded
section('Local IM remove → engine push (tombstone)')
;(async () => {
  const { im, dropbox, setup } = makeSetup()
  const created = im.create({ name: 'WillDelete' })
  await setup.engine.drainOnce() // push the upsert
  im.remove(created.id)
  await setup.engine.drainOnce() // push the tombstone
  ok(
    'dropbox still has the path (now tombstone)',
    dropbox._hasPath(`/sync/identitys/${created.id}.json.enc`),
  )
  ok('queue empty after both pushes', setup.queue.size() === 0)
})()

// 4. Remote upload → puller applies to IM
section('Remote upload → puller.pullOnce → applyRemoteUpsert → IM updated')
;(async () => {
  const { im, dropbox, setup, encodeRecord } = makeSetup({
    deviceFolder: 'mac-aaaa1111',
  })
  // Seed Dropbox with a record from a DIFFERENT device.
  const remoteHeader = {
    schemaVersion: 1,
    updatedAt: '2026-05-11T10:00:00.000Z',
    deviceFolder: 'mac-bbbb2222', // foreign
    recordType: 'identity',
    recordId: 'rec-from-bob',
    deleted: false,
  }
  const remoteBody = {
    id: 'rec-from-bob',
    name: 'Maria from Bob Mac',
    color: '#ff8800',
    fingerprintSeed: 'maria-seed',
    workspaceId: 'general',
    locked: false,
    createdAt: 1715346000000,
    updatedAt: '2026-05-11T10:00:00.000Z',
  }
  const buf = encodeRecord(MASTER_KEY, remoteHeader, remoteBody)
  await dropbox.upload('/sync/identitys/rec-from-bob.json.enc', buf)

  // Trigger pull.
  const r = await setup.pullNow()
  ok("status 'ok'", r.status === 'ok')
  ok('applied >= 1', r.applied >= 1)
  ok('IM has the new identity', im.get('rec-from-bob') !== null)
  ok('name matches remote body', im.get('rec-from-bob').name === 'Maria from Bob Mac')
})()

// 5. Remote tombstone → puller applies → IM removed
section('Remote tombstone → puller.pullOnce → applyRemoteDelete → IM removed')
;(async () => {
  const { im, dropbox, setup, encodeRecord } = makeSetup({
    deviceFolder: 'mac-aaaa1111',
  })
  // Seed local with an identity that came from Bob earlier.
  const { applyRemoteUpsert } = require('../browser/identity-manager-sync')
  applyRemoteUpsert(im, {
    id: 'rec-doomed',
    name: 'About To Tombstone',
    color: '#777',
    fingerprintSeed: 'seed',
    workspaceId: 'general',
    updatedAt: '2026-05-11T09:00:00.000Z',
  })
  ok('IM has the seeded identity', im.get('rec-doomed') !== null)

  // Now Bob deletes it → tombstone lands on Dropbox.
  const tombstoneHeader = {
    schemaVersion: 1,
    updatedAt: '2026-05-11T11:00:00.000Z',
    deviceFolder: 'mac-bbbb2222',
    recordType: 'identity',
    recordId: 'rec-doomed',
    deleted: true,
    deletedAt: '2026-05-11T11:00:00.000Z',
  }
  const buf = encodeRecord(MASTER_KEY, tombstoneHeader, null)
  await dropbox.upload('/sync/identitys/rec-doomed.json.enc', buf)

  await setup.pullNow()
  ok('IM no longer has the doomed identity', im.get('rec-doomed') === null)
})()

// 6. Self-uploads are NOT re-applied locally (no echo)
section('Self-uploads skipped on pull')
;(async () => {
  const { im, setup } = makeSetup({ deviceFolder: 'mac-aaaa1111' })
  // Locally create + push (which uploads with deviceFolder=mac-aaaa1111)
  im.create({ name: 'NoEcho' })
  await setup.engine.drainOnce()
  // Now pull — the dropbox entry has our own deviceFolder, should be skipped.
  const remoteApplied = []
  im.on('remote-applied', (e) => remoteApplied.push(e))
  await setup.pullNow()
  ok(
    'no remote-applied events for self-uploads',
    remoteApplied.length === 0,
    `got ${remoteApplied.length} events`,
  )
})()

// 7. applyRemote does NOT push back (no infinite loop)
section('applyRemote does NOT push back')
;(async () => {
  const { im, setup, encodeRecord, dropbox } = makeSetup({
    deviceFolder: 'mac-aaaa1111',
  })
  // Remote record from Bob
  const buf = encodeRecord(
    MASTER_KEY,
    {
      schemaVersion: 1,
      updatedAt: '2026-05-11T10:00:00.000Z',
      deviceFolder: 'mac-bbbb2222',
      recordType: 'identity',
      recordId: 'rec-noloop',
      deleted: false,
    },
    {
      id: 'rec-noloop',
      name: 'No Loop',
      color: '#aaa',
      fingerprintSeed: 'seed',
      workspaceId: 'general',
      updatedAt: '2026-05-11T10:00:00.000Z',
    },
  )
  await dropbox.upload('/sync/identitys/rec-noloop.json.enc', buf)

  await setup.pullNow()
  ok('IM has the applied identity', im.get('rec-noloop') !== null)
  ok('queue is empty (applyRemote did NOT trigger push)', setup.queue.size() === 0)
})()

// 8. start/stop lifecycle
section('start/stop lifecycle')
{
  const { setup } = makeSetup()
  ok('not running initially', setup.isRunning() === false)
  setup.start()
  ok('running after start', setup.isRunning() === true)
  setup.start() // idempotent
  ok('still running after second start', setup.isRunning() === true)
  setup.stop()
  ok('not running after stop', setup.isRunning() === false)
  setup.stop() // idempotent
  ok('still not running after second stop', setup.isRunning() === false)
}

// 9. Round-trip: Alice creates → drain → Bob's view pulls + applies
section('Round-trip: Alice push → Bob pull')
;(async () => {
  const { IdentityManager, setupSync } = freshIM()

  // Shared "Dropbox" between the two devices
  const sharedDropbox = makeFakeDropbox()
  const vault = makeFakeVault()

  // --- Alice ---
  const aliceIM = new IdentityManager()
  const aliceSetup = setupSync({
    vault,
    dropbox: sharedDropbox,
    identityManager: aliceIM,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-alice-1111',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  const aliceRecord = aliceIM.create({ name: 'Cliente IG #1', workspaceId: 'general' })
  await aliceSetup.engine.drainOnce()
  ok(
    'Alice uploaded the record',
    sharedDropbox._hasPath(`/sync/identitys/${aliceRecord.id}.json.enc`),
  )

  // --- Bob (different deviceFolder, separate IM) ---
  // Tear down Alice's userdata so Bob starts fresh.
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  fakeElectron.session.__partitionCache = new Map()
  delete require.cache[require.resolve('../browser/identity-manager.js')]
  delete require.cache[require.resolve('../browser/identity-manager-sync.js')]
  delete require.cache[require.resolve('../browser/sync-queue.js')]
  delete require.cache[require.resolve('../browser/sync-engine.js')]
  delete require.cache[require.resolve('../browser/sync-pull.js')]
  delete require.cache[require.resolve('../browser/sync-setup.js')]

  const { IdentityManager: BobIM } = require('../browser/identity-manager.js')
  const { setupSync: setupSyncBob } = require('../browser/sync-setup.js')
  const bobIM = new BobIM()
  const bobSetup = setupSyncBob({
    vault,
    dropbox: sharedDropbox,
    identityManager: bobIM,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-bob-2222',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  ok('Bob does not have the record locally yet', bobIM.get(aliceRecord.id) === null)
  await bobSetup.pullNow()
  ok('Bob has the record after pull', bobIM.get(aliceRecord.id) !== null)
  ok(
    'Bob sees the same name as Alice',
    bobIM.get(aliceRecord.id).name === 'Cliente IG #1',
  )
})()

// ---------- Async wait + summary --------------------------------------------

setTimeout(() => {
  Module._load = originalLoad
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures)
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    process.exit(1)
  }
  process.exit(0)
}, 500)

// Reference EventEmitter so eslint doesn't flag unused import.
void EventEmitter
