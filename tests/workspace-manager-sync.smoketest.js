// OZ Browser — WorkspaceManager remote-apply smoke test (D-4 mini CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/workspace-manager-sync.smoketest.js
//
// Cubre:
//   - applyRemoteUpsert: new id → create
//   - applyRemoteUpsert: existing id → update (in-place, preserves local tabSpecs)
//   - applyRemoteUpsert: id='general' → rejected (returns null)
//   - applyRemoteUpsert: invalid record / missing id → rejected
//   - applyRemoteUpsert: missing updatedAt → backfilled defensively
//   - applyRemoteUpsert: NEVER emits 'changed' (would loop the sync engine)
//   - applyRemoteUpsert: emits 'remote-applied' with payload
//   - applyRemoteUpsert: remote claim of isDefault is forced to false
//   - applyRemoteUpsert: tabSpecs / activeTabId from remote are STRIPPED
//     (privacy carveout — local tabSpecs preserved)
//   - applyRemoteDelete: existing id → removes, op='delete'
//   - applyRemoteDelete: id='general' → rejected
//   - applyRemoteDelete: missing id → idempotent null
//   - applyRemoteDelete: NEVER emits 'changed'
//   - applyRemoteDelete: emits 'remote-applied' with deletedAt
//   - throwing 'remote-applied' listener does NOT break the apply

'use strict'

const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---------- Electron mock ---------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-wmsync-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeElectron = {
  app: {
    getPath(key) {
      if (key === 'userData') return TEST_USERDATA
      if (key === 'logs') return TEST_LOGS
      return TEST_USERDATA
    },
    getName: () => 'OZ Browser Test',
    on() {},
    whenReady: () => Promise.resolve(),
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

function freshWM() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/workspace-manager.js')]
  delete require.cache[require.resolve('../browser/workspace-manager-sync.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { WorkspaceManager } = require('../browser/workspace-manager.js')
  const {
    applyRemoteUpsert,
    applyRemoteDelete,
  } = require('../browser/workspace-manager-sync.js')
  return { WorkspaceManager, applyRemoteUpsert, applyRemoteDelete }
}

console.log('OZ Browser — workspace-manager-sync (remote-apply) smoke test')

// 1. applyRemoteUpsert creates a new workspace
section('applyRemoteUpsert: new id → create')
{
  const { WorkspaceManager, applyRemoteUpsert } = freshWM()
  const wm = new WorkspaceManager()

  const changes = []
  const remoteApplied = []
  wm.on('changed', (e) => changes.push(e))
  wm.on('remote-applied', (e) => remoteApplied.push(e))

  const result = applyRemoteUpsert(wm, {
    id: 'remote-ws-1',
    name: 'Workspace From Maria',
    color: '#ff00ff',
    quickTabsMode: 'on-click',
    isArchived: false,
    isFrozen: false,
    identityIds: ['id-1', 'id-2'],
    createdAt: 1715346000000,
    updatedAt: '2026-05-11T10:00:00.000Z',
  })

  ok("returns op='create'", result && result.op === 'create')
  ok('workspace persisted', wm.get('remote-ws-1') !== null)
  ok('name matches', wm.get('remote-ws-1').name === 'Workspace From Maria')
  ok('color matches', wm.get('remote-ws-1').color === '#ff00ff')
  ok('identityIds preserved', wm.get('remote-ws-1').identityIds.length === 2)
  ok('no changed emit (avoids push loop)', changes.length === 0)
  ok('1 remote-applied emit', remoteApplied.length === 1)
  ok('remote-applied op=create', remoteApplied[0].op === 'create')
  ok("remote-applied recordType='workspace'", remoteApplied[0].recordType === 'workspace')
}

// 2. applyRemoteUpsert updates existing, preserves local tabSpecs
section('applyRemoteUpsert: existing → update, STRIPS remote tabSpecs')
{
  const { WorkspaceManager, applyRemoteUpsert } = freshWM()
  const wm = new WorkspaceManager()
  const local = wm.create({ name: 'Local Initial' })
  // Seed local tabSpecs
  wm.setTabSpecs(local.id, [
    { id: 't1', identityId: 'id-a', url: 'https://example.com', title: 'Local Tab' },
  ])

  const changes = []
  wm.on('changed', (e) => changes.push(e))

  applyRemoteUpsert(wm, {
    id: local.id,
    name: 'Renamed By Maria',
    color: '#00ff00',
    quickTabsMode: 'load-all',
    identityIds: ['id-x'],
    // Remote sends tabSpecs that should be STRIPPED
    tabSpecs: [
      { id: 't-remote', identityId: 'remote-id', url: 'https://leak.com', title: 'LEAK' },
    ],
    activeTabId: 't-remote',
    updatedAt: '2026-05-11T11:00:00.000Z',
  })

  const after = wm.get(local.id)
  ok('name updated', after.name === 'Renamed By Maria')
  ok('color updated', after.color === '#00ff00')
  ok('quickTabsMode updated', after.quickTabsMode === 'load-all')
  ok(
    'identityIds replaced',
    after.identityIds.length === 1 && after.identityIds[0] === 'id-x',
  )
  ok(
    'local tabSpecs PRESERVED (remote tabSpecs stripped)',
    after.tabSpecs.length === 1 && after.tabSpecs[0].id === 't1',
  )
  ok('local activeTabId preserved (remote not applied)', after.activeTabId !== 't-remote')
  ok("no 'changed' emit on remote update", changes.length === 0)
}

// 3. applyRemoteUpsert rejects 'general' workspace
section('applyRemoteUpsert: refuses General')
{
  const { WorkspaceManager, applyRemoteUpsert } = freshWM()
  const wm = new WorkspaceManager()
  const generalBefore = JSON.parse(JSON.stringify(wm.get('general')))
  const result = applyRemoteUpsert(wm, {
    id: 'general',
    name: 'Sneaky Attempt',
    updatedAt: '2026-05-11T10:00:00.000Z',
  })
  ok('returns null', result === null)
  ok('General unchanged', wm.get('general').name === generalBefore.name)
}

// 4. applyRemoteUpsert rejects invalid records
section('applyRemoteUpsert: validation')
{
  const { WorkspaceManager, applyRemoteUpsert } = freshWM()
  const wm = new WorkspaceManager()
  ok('null → null', applyRemoteUpsert(wm, null) === null)
  ok('missing id → null', applyRemoteUpsert(wm, { name: 'No ID' }) === null)
  ok('non-string id → null', applyRemoteUpsert(wm, { id: 42 }) === null)
}

// 5. applyRemoteUpsert backfills missing updatedAt
section('applyRemoteUpsert: defensive updatedAt backfill')
{
  const { WorkspaceManager, applyRemoteUpsert } = freshWM()
  const wm = new WorkspaceManager()
  applyRemoteUpsert(wm, { id: 'no-ts', name: 'Sin Timestamp' })
  const applied = wm.get('no-ts')
  ok(
    'updatedAt backfilled to ISO',
    typeof applied.updatedAt === 'string' && !Number.isNaN(Date.parse(applied.updatedAt)),
  )
  applyRemoteUpsert(wm, { id: 'bad-ts', name: 'Mal', updatedAt: 'not-iso' })
  const applied2 = wm.get('bad-ts')
  ok(
    'malformed updatedAt backfilled',
    typeof applied2.updatedAt === 'string' &&
      !Number.isNaN(Date.parse(applied2.updatedAt)),
  )
}

// 6. Remote isDefault is forced to false
section('applyRemoteUpsert: never lets remote claim isDefault')
{
  const { WorkspaceManager, applyRemoteUpsert } = freshWM()
  const wm = new WorkspaceManager()
  applyRemoteUpsert(wm, {
    id: 'sneaky',
    name: 'Trying',
    updatedAt: '2026-05-11T10:00:00.000Z',
    isDefault: true,
  })
  ok('remote isDefault=true forced to false', wm.get('sneaky').isDefault === false)
}

// 7. applyRemoteDelete removes a workspace
section('applyRemoteDelete: existing → delete')
{
  const { WorkspaceManager, applyRemoteDelete } = freshWM()
  const wm = new WorkspaceManager()
  const created = wm.create({ name: 'ToDelete' })

  const changes = []
  const remoteApplied = []
  wm.on('changed', (e) => changes.push(e))
  wm.on('remote-applied', (e) => remoteApplied.push(e))

  const result = applyRemoteDelete(wm, created.id, '2026-05-11T12:00:00.000Z')
  ok("returns op='delete'", result && result.op === 'delete')
  ok('workspace gone locally', wm.get(created.id) === null)
  ok("no 'changed' emit", changes.length === 0)
  ok('1 remote-applied emit', remoteApplied.length === 1)
  ok("remote-applied op='delete'", remoteApplied[0].op === 'delete')
  ok(
    'remote-applied carries deletedAt',
    remoteApplied[0].deletedAt === '2026-05-11T12:00:00.000Z',
  )
}

// 8. applyRemoteDelete idempotent
section('applyRemoteDelete: missing → idempotent null')
{
  const { WorkspaceManager, applyRemoteDelete } = freshWM()
  const wm = new WorkspaceManager()
  const result = applyRemoteDelete(wm, 'never-existed', '2026-05-11T12:00:00.000Z')
  ok('returns null', result === null)
}

// 9. applyRemoteDelete rejects 'general'
section('applyRemoteDelete: refuses General')
{
  const { WorkspaceManager, applyRemoteDelete } = freshWM()
  const wm = new WorkspaceManager()
  const result = applyRemoteDelete(wm, 'general')
  ok('returns null', result === null)
  ok('General still exists', wm.get('general') !== null)
}

// 10. applyRemoteDelete invalid recordId
section('applyRemoteDelete: validation')
{
  const { WorkspaceManager, applyRemoteDelete } = freshWM()
  const wm = new WorkspaceManager()
  ok('undefined recordId → null', applyRemoteDelete(wm, undefined) === null)
  ok('empty string → null', applyRemoteDelete(wm, '') === null)
  ok('non-string → null', applyRemoteDelete(wm, 42) === null)
}

// 11. Throwing remote-applied listener does NOT break the apply
section('throwing remote-applied listener is isolated')
{
  const { WorkspaceManager, applyRemoteUpsert } = freshWM()
  const wm = new WorkspaceManager()
  wm.on('remote-applied', () => {
    throw new Error('intentional listener fault')
  })
  let result
  try {
    result = applyRemoteUpsert(wm, {
      id: 'rec-thrower',
      name: 'Survives Throw',
      updatedAt: '2026-05-11T10:00:00.000Z',
    })
  } catch (e) {
    result = { _err: e.message }
  }
  ok('apply still returned a result', result && result.op === 'create')
  ok('apply persisted state despite listener throw', wm.get('rec-thrower') !== null)
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
