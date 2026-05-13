// OZ Browser — IdentityManager 'changed' events smoke test (D-3a CORE).
//
// Cómo correr:
//   cd oz-browser
//   node tests/identity-manager-events.smoketest.js
//
// Cubre:
//   - IdentityManager extiende EventEmitter
//   - create / update / setLocked / moveToWorkspace / remove emiten 'changed'
//   - payload: { op, recordType, recordId, record?, updatedAt | deletedAt }
//   - updatedAt es ISO 8601 string, se stamp en cada mutación efectiva
//   - update no-op y setLocked idempotente NO emiten ni stamp
//   - listener que tira no rompe la mutación (try/catch wrap)
//   - legacy identities sin updatedAt → backfill on _load(): ISO(createdAt)
//
// Split from identity-manager.smoketest.js per ADR 0005 (500 LOC rule).

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ---------- Electron mock ----------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-im-events-'))
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

// ---------- Test runner ------------------------------------------------------

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

  // OZ_TIER=paid bypasses the free-tier cap so we can create freely.
  const prevTier = process.env.OZ_TIER
  process.env.OZ_TIER = 'paid'

  delete require.cache[require.resolve('../browser/identity-manager.js')]
  delete require.cache[require.resolve('../browser/logger.js')]

  const mod = require('../browser/identity-manager.js')
  return {
    ...mod,
    _restoreEnv: () => {
      if (prevTier === undefined) delete process.env.OZ_TIER
      else process.env.OZ_TIER = prevTier
    },
  }
}

// Busy-wait until the wall clock advances at least 1ms. Date.toISOString
// resolves to ms precision so two synchronous mutations can collide.
function tickForward() {
  const start = Date.now()
  while (Date.now() === start) {
    /* spin */
  }
}

// ----- Test cases ------------------------------------------------------------

console.log("OZ Browser — IdentityManager 'changed' events smoke test")

// 1. EventEmitter wiring + create event
section('EventEmitter + create')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  ok(
    'IdentityManager is an EventEmitter',
    typeof im.on === 'function' && typeof im.emit === 'function',
  )

  const events = []
  im.on('changed', (p) => events.push(p))

  const created = im.create({ name: 'SyncTarget', workspaceId: 'general' })
  const createEvt = events.find((e) => e.op === 'create' && e.recordId === created.id)
  ok("create emits 'changed' op=create", !!createEvt)
  ok(
    "create event has recordType='identity'",
    createEvt && createEvt.recordType === 'identity',
  )
  ok(
    'create event carries the record body',
    createEvt && createEvt.record && createEvt.record.id === created.id,
  )
  ok(
    'create event has ISO updatedAt',
    createEvt &&
      typeof createEvt.updatedAt === 'string' &&
      !Number.isNaN(Date.parse(createEvt.updatedAt)),
  )
  ok(
    'identity.updatedAt is an ISO string after create',
    typeof created.updatedAt === 'string' && !Number.isNaN(Date.parse(created.updatedAt)),
  )
}

// 2. update emits + advances updatedAt; no-op update does not
section('update + no-op guard')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  const created = im.create({ name: 'X' })

  const events = []
  im.on('changed', (p) => events.push(p))

  const before = created.updatedAt
  tickForward()
  const renamed = im.update(created.id, { name: 'X Renamed' })
  const updateEvt = events.find((e) => e.op === 'update' && e.recordId === created.id)
  ok("update emits 'changed' op=update", !!updateEvt)
  ok(
    'update advances updatedAt',
    renamed.updatedAt > before,
    `before=${before} after=${renamed.updatedAt}`,
  )
  ok(
    'update event.record reflects new name',
    updateEvt && updateEvt.record && updateEvt.record.name === 'X Renamed',
  )

  events.length = 0
  const stableTs = renamed.updatedAt
  tickForward()
  const after = im.update(created.id, { name: 'X Renamed' })
  ok('no-op update does not emit', events.length === 0)
  ok('no-op update does not stamp updatedAt', after.updatedAt === stableTs)
}

// 3. setLocked emits + idempotent guard
section('setLocked + idempotent guard')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  const created = im.create({ name: 'LockTest' })

  const events = []
  im.on('changed', (p) => events.push(p))

  im.setLocked(created.id, true)
  const lockEvt = events.find((e) => e.op === 'update' && e.recordId === created.id)
  ok("setLocked emits 'changed' op=update", !!lockEvt)
  ok(
    'locked event payload reflects locked:true',
    lockEvt && lockEvt.record.locked === true,
  )

  events.length = 0
  im.setLocked(created.id, true)
  ok('idempotent setLocked does not re-emit', events.length === 0)
}

// 4. moveToWorkspace emits
section('moveToWorkspace')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  const created = im.create({ name: 'Movable', workspaceId: 'ws-a' })

  const events = []
  im.on('changed', (p) => events.push(p))

  im.moveToWorkspace(created.id, 'ws-b')
  const moveEvt = events.find((e) => e.op === 'update' && e.recordId === created.id)
  ok("moveToWorkspace emits 'changed' op=update", !!moveEvt)
  ok(
    'move event payload reflects new workspaceId',
    moveEvt && moveEvt.record.workspaceId === 'ws-b',
  )
}

// 5. remove emits tombstone with deletedAt
section('remove → tombstone')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  const created = im.create({ name: 'ToDelete' })

  const events = []
  im.on('changed', (p) => events.push(p))

  im.remove(created.id)
  const delEvt = events.find((e) => e.op === 'delete' && e.recordId === created.id)
  ok("remove emits 'changed' op=delete", !!delEvt)
  ok("delete event has recordType='identity'", delEvt && delEvt.recordType === 'identity')
  ok(
    'delete event has ISO deletedAt',
    delEvt &&
      typeof delEvt.deletedAt === 'string' &&
      !Number.isNaN(Date.parse(delEvt.deletedAt)),
  )
}

// 6. Throwing listener does NOT break the mutation
section('throwing listener is isolated')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  const created = im.create({ name: 'ListenerTest' })

  im.on('changed', () => {
    throw new Error('intentional listener fault')
  })

  let mutationOk = false
  try {
    im.update(created.id, { name: 'Renamed Despite Throw' })
    mutationOk = true
  } catch (_e) {
    mutationOk = false
  }
  ok('throwing listener does not break mutation', mutationOk)
  const after = im.get(created.id)
  ok('mutation persisted despite listener throw', after.name === 'Renamed Despite Throw')
}

// 7. Legacy identities (no updatedAt) get backfilled on _load
section('updatedAt backfill on _load')
{
  const { IdentityManager } = freshIM()
  const fp = path.join(TEST_USERDATA, 'identities.json')
  fs.writeFileSync(
    fp,
    JSON.stringify([
      {
        id: 'default',
        name: 'Default',
        color: '#8a8a8a',
        fingerprintSeed: 'a',
        createdAt: 1715346000000, // back-dated ms; we'll assert the same instant
        isDefault: true,
        workspaceId: 'general',
        locked: false,
        // no updatedAt
      },
      {
        id: 'legacy-2',
        name: 'No Timestamp',
        color: '#ff0000',
        fingerprintSeed: 'b',
        // no createdAt → should default to current time
        workspaceId: 'general',
      },
    ]),
  )
  const im = new IdentityManager()
  const list = im.list()
  ok(
    'all identities have ISO updatedAt after _load',
    list.every(
      (i) => typeof i.updatedAt === 'string' && !Number.isNaN(Date.parse(i.updatedAt)),
    ),
  )
  const def = list.find((i) => i.id === 'default')
  ok(
    'identity with createdAt gets updatedAt that parses to the same instant',
    def && Date.parse(def.updatedAt) === 1715346000000,
    def
      ? `updatedAt=${def.updatedAt} parses to ${Date.parse(def.updatedAt)}`
      : 'no default',
  )
  const noTs = list.find((i) => i.id === 'legacy-2')
  ok(
    'identity without createdAt gets a fresh updatedAt',
    noTs && Date.parse(noTs.updatedAt) > Date.parse('2025-01-01T00:00:00.000Z'),
  )
}

// ---------- Cleanup ----------------------------------------------------------

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
