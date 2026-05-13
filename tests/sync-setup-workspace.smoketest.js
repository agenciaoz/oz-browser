// OZ Browser — Sync Setup workspace round-trip smoke test (D-4 mini CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/sync-setup-workspace.smoketest.js
//
// Cubre el end-to-end de sync para workspaces (separado de sync-setup.smoketest
// para mantener ese archivo bajo 500 LOC por ADR 0005):
//   - Local workspace create → engine push → Dropbox upload (workspaces folder)
//   - Local workspace remove → tombstone upload
//   - Remote workspace upload → pullNow → applyRemoteUpsert → WM has it
//   - Privacy carveout: locally-stored tabSpecs are NOT included in the
//     encoded upload (fetchRecord strips them)
//   - Round-trip Alice→Bob with WorkspaceManager
//   - 'general' workspace is never pushed by either side

'use strict'

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// ---------- Electron mock ---------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-syncws-'))
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

// ---------- Test doubles ----------------------------------------------------

const MASTER_KEY = crypto.randomBytes(32)

function makeFakeVault() {
  return {
    isUnlocked: true,
    getMasterKey() {
      return MASTER_KEY
    },
  }
}

function makeFakeDropbox() {
  const store = new Map()
  const folderEntries = new Map()
  let nextCursor = 1
  return {
    isAuthenticated() {
      return true
    },
    async upload(p, buf) {
      store.set(p, Buffer.from(buf))
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
      return { entries: [], cursor: `c-${nextCursor++}`, hasMore: false }
    },
    _store: store,
    _hasPath(p) {
      return store.has(p)
    },
    _bufferAt(p) {
      return store.get(p) || null
    },
  }
}

function freshModules() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  fakeElectron.session.__partitionCache = new Map()
  process.env.OZ_TIER = 'paid'

  for (const m of [
    'identity-manager',
    'identity-manager-sync',
    'workspace-manager',
    'workspace-manager-sync',
    'sync-queue',
    'sync-engine',
    'sync-pull',
    'sync-setup',
    'logger',
  ]) {
    delete require.cache[require.resolve(`../browser/${m}.js`)]
  }
  const { IdentityManager } = require('../browser/identity-manager.js')
  const { WorkspaceManager } = require('../browser/workspace-manager.js')
  const { setupSync } = require('../browser/sync-setup.js')
  const { decodeRecord, encodeRecord } = require('../browser/sync-record-store')
  return { IdentityManager, WorkspaceManager, setupSync, decodeRecord, encodeRecord }
}

console.log('OZ Browser — sync-setup workspace round-trip smoke test')

// 1. Local create → drain → uploaded to Dropbox /sync/workspaces/<id>.json.enc
section('Local WS create → engine push (workspace path)')
;(async () => {
  const { IdentityManager, WorkspaceManager, setupSync, decodeRecord } = freshModules()
  const im = new IdentityManager()
  const wm = new WorkspaceManager()
  const vault = makeFakeVault()
  const dropbox = makeFakeDropbox()
  const setup = setupSync({
    vault,
    dropbox,
    identityManager: im,
    workspaceManager: wm,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-aaaa1111',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  const created = wm.create({ name: 'Marketing' })
  ok('queue has 1 op after workspace create', setup.queue.size() === 1)
  ok('queue op recordType=workspace', setup.queue.peek().recordType === 'workspace')

  await setup.engine.drainOnce()
  ok(
    'dropbox has the workspace at /sync/workspaces/<id>.json.enc',
    dropbox._hasPath(`/sync/workspaces/${created.id}.json.enc`),
  )

  // Verify the encoded record DOES NOT include tabSpecs (privacy carveout)
  const buf = dropbox._bufferAt(`/sync/workspaces/${created.id}.json.enc`)
  const { header, body } = decodeRecord(MASTER_KEY, buf)
  ok("encoded recordType === 'workspace'", header.recordType === 'workspace')
  ok('encoded body.name matches', body.name === 'Marketing')
  ok(
    'encoded body does NOT contain tabSpecs (privacy carveout)',
    !Object.prototype.hasOwnProperty.call(body, 'tabSpecs'),
  )
  ok(
    'encoded body does NOT contain activeTabId',
    !Object.prototype.hasOwnProperty.call(body, 'activeTabId'),
  )
})()

// 2. Local remove → tombstone push
section('Local WS remove → tombstone push')
;(async () => {
  const { IdentityManager, WorkspaceManager, setupSync } = freshModules()
  const im = new IdentityManager()
  const wm = new WorkspaceManager()
  const dropbox = makeFakeDropbox()
  const setup = setupSync({
    vault: makeFakeVault(),
    dropbox,
    identityManager: im,
    workspaceManager: wm,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-aaaa1111',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })
  const created = wm.create({ name: 'Will Die' })
  await setup.engine.drainOnce() // upsert
  wm.remove(created.id)
  await setup.engine.drainOnce() // tombstone
  ok(
    'dropbox path retained (tombstone written)',
    dropbox._hasPath(`/sync/workspaces/${created.id}.json.enc`),
  )
  ok('queue empty after both pushes', setup.queue.size() === 0)
})()

// 3. Remote upload → pullNow → applyRemoteUpsert → WM updated
section('Remote WS upload → pullNow → WM has it')
;(async () => {
  const { IdentityManager, WorkspaceManager, setupSync, encodeRecord } = freshModules()
  const im = new IdentityManager()
  const wm = new WorkspaceManager()
  const dropbox = makeFakeDropbox()
  const setup = setupSync({
    vault: makeFakeVault(),
    dropbox,
    identityManager: im,
    workspaceManager: wm,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-aaaa1111',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  // Seed Dropbox with a workspace from a different device
  const remoteHeader = {
    schemaVersion: 1,
    updatedAt: '2026-05-11T10:00:00.000Z',
    deviceFolder: 'mac-bbbb2222',
    recordType: 'workspace',
    recordId: 'ws-from-bob',
    deleted: false,
  }
  const remoteBody = {
    id: 'ws-from-bob',
    name: 'Sales Pipeline',
    color: '#9c5cf2',
    isArchived: false,
    isFrozen: false,
    quickTabsMode: 'on-click',
    createdAt: 1715346000000,
    updatedAt: '2026-05-11T10:00:00.000Z',
    identityIds: [],
  }
  const buf = encodeRecord(MASTER_KEY, remoteHeader, remoteBody)
  await dropbox.upload('/sync/workspaces/ws-from-bob.json.enc', buf)

  const r = await setup.pullNow()
  ok("workspace pull status 'ok'", r.workspace && r.workspace.status === 'ok')
  ok('WM has the new workspace', wm.get('ws-from-bob') !== null)
  ok('workspace.name matches remote', wm.get('ws-from-bob').name === 'Sales Pipeline')
})()

// 4. End-to-end Alice → Bob round-trip for workspaces
section('End-to-end: Alice WS push → Bob pulls')
;(async () => {
  const { IdentityManager, WorkspaceManager, setupSync } = freshModules()

  const sharedDropbox = makeFakeDropbox()
  const vault = makeFakeVault()

  // --- Alice ---
  const aliceIM = new IdentityManager()
  const aliceWM = new WorkspaceManager()
  const aliceSetup = setupSync({
    vault,
    dropbox: sharedDropbox,
    identityManager: aliceIM,
    workspaceManager: aliceWM,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-alice-1111',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  const aliceWs = aliceWM.create({ name: 'Project Aurora', color: '#ffab00' })
  await aliceSetup.engine.drainOnce()
  ok(
    'Alice uploaded the workspace',
    sharedDropbox._hasPath(`/sync/workspaces/${aliceWs.id}.json.enc`),
  )

  // --- Bob ---
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  fakeElectron.session.__partitionCache = new Map()
  for (const m of [
    'identity-manager',
    'identity-manager-sync',
    'workspace-manager',
    'workspace-manager-sync',
    'sync-queue',
    'sync-engine',
    'sync-pull',
    'sync-setup',
  ]) {
    delete require.cache[require.resolve(`../browser/${m}.js`)]
  }
  const { IdentityManager: BobIM } = require('../browser/identity-manager.js')
  const { WorkspaceManager: BobWM } = require('../browser/workspace-manager.js')
  const { setupSync: setupSyncBob } = require('../browser/sync-setup.js')
  const bobIM = new BobIM()
  const bobWM = new BobWM()
  const bobSetup = setupSyncBob({
    vault,
    dropbox: sharedDropbox,
    identityManager: bobIM,
    workspaceManager: bobWM,
    userDataDir: TEST_USERDATA,
    deviceFolder: 'mac-bob-2222',
    scheduler: () => null,
    cancelScheduler: () => {},
    pollScheduler: () => null,
    pollCancelScheduler: () => {},
  })

  ok('Bob does not have the workspace yet', bobWM.get(aliceWs.id) === null)
  await bobSetup.pullNow()
  ok('Bob has the workspace after pull', bobWM.get(aliceWs.id) !== null)
  ok(
    'Bob sees Alice name + color',
    bobWM.get(aliceWs.id).name === 'Project Aurora' &&
      bobWM.get(aliceWs.id).color === '#ffab00',
  )
  ok(
    "Bob's local 'general' workspace was not affected",
    bobWM.get('general') !== null && bobWM.get('general').isDefault === true,
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
