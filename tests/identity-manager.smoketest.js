// OZ Browser — IdentityManager smoke test (mock-Electron, Node-puro).
//
// Cómo correr:
//   cd oz-browser
//   node tests/identity-manager.smoketest.js
//
// Cubre:
//   - _load() auto-crea Default si falta
//   - create() respeta MAX_IDENTITIES_FREE (3)
//   - OZ_TIER=paid bypassa el cap
//   - update() patch genérico (name, color, userAgent)
//   - update() rechaza userAgent en Default
//   - getSession() devuelve defaultSession para Default, partition para otras
//   - getSession() aplica setUserAgent cuando hay custom UA
//   - update(userAgent) aplica setUserAgent en vivo a la session cacheada
//
// NO cubre (requiere GUI):
//   - Materialización de tabs lazy (necesita WebContentsView real)
//   - Modal identity-editor.html (requiere webContents y DOM)
//   - Bug tab duplicada al arranque (requiere correr la app entera)

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

// ---------- Electron mock ----------------------------------------------------

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const setUACalls = [] // { sessionLabel, ua }

function makeFakeSession(label) {
  return {
    __label: label,
    setUserAgent(ua) {
      setUACalls.push({ sessionLabel: label, ua })
    },
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
    getAppPath: () => path.resolve(__dirname, '..'), // 1.5f: contentPreloadPath()
    on() {},
    whenReady: () => Promise.resolve(),
  },
  session: {
    defaultSession: makeFakeSession('default'),
    fromPartition: (partition) => {
      // Realistic: each partition string returns a distinct session-like obj
      // (cached so two calls with same partition share the obj — replicates
      // Electron's actual behaviour we depend on in IdentityManager.sessionCache).
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

// Hijack require('electron') BEFORE loading IdentityManager.
const originalResolve = Module._resolveFilename
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

function freshIM(envOverride = {}) {
  // Wipe state from previous tests.
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  fakeElectron.session.__partitionCache = new Map()
  setUACalls.length = 0

  // Bust require cache + apply env overrides.
  const prevTier = process.env.OZ_TIER
  if (envOverride.OZ_TIER === undefined) {
    delete process.env.OZ_TIER
  } else {
    process.env.OZ_TIER = envOverride.OZ_TIER
  }
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

// ----- Test cases ------------------------------------------------------------

console.log('OZ Browser — IdentityManager smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. _load auto-creates Default
section('_load() auto-crea Default')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  const list = im.list()
  ok('list().length === 1', list.length === 1)
  ok('list()[0].isDefault === true', list[0].isDefault === true)
  ok('list()[0].name === "Default"', list[0].name === 'Default')
  ok(
    'Default.userAgent ausente o null',
    list[0].userAgent === undefined || list[0].userAgent === null,
  )
}

// 2. create() respeta cap SOLO si OZ_TIER=free explícito (1.5f flip).
section('Cap free tier MAX_IDENTITIES_FREE=3 (OZ_TIER=free opt-in)')
{
  const { IdentityManager, IdentityCapError, MAX_IDENTITIES_FREE, _restoreEnv } = freshIM(
    { OZ_TIER: 'free' },
  )
  ok('MAX_IDENTITIES_FREE exportado === 3', MAX_IDENTITIES_FREE === 3)
  ok('IdentityCapError exportado', typeof IdentityCapError === 'function')

  const im = new IdentityManager()
  im.create({ name: 'Cliente A' })
  im.create({ name: 'Cliente B' })
  ok('crea hasta llegar a 3 identities', im.list().length === 3)

  let threw = null
  try {
    im.create({ name: 'Cliente C' })
  } catch (e) {
    threw = e
  }
  ok(
    '4ta identity tira IdentityCapError con OZ_TIER=free',
    threw && threw.code === 'IDENTITY_CAP_REACHED',
    threw ? `code=${threw.code} message=${threw.message.slice(0, 80)}` : 'no throw',
  )
  ok('error tiene current/max correctos', threw && threw.current === 3 && threw.max === 3)
  _restoreEnv()
}

// 3. Default behavior (sin OZ_TIER) = sin cap (1.5f Jose use case = 50+ accounts)
section('Default sin OZ_TIER === paid (sin cap)')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  for (let i = 0; i < 10; i++) im.create({ name: `Bulk ${i}` })
  ok('crea 10+ identities sin error sin OZ_TIER set', im.list().length === 11)
}

// 4. OZ_TIER=paid sigue funcionando (alias explícito)
section('OZ_TIER=paid bypassa cap (alias explícito)')
{
  const { IdentityManager, _restoreEnv } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  for (let i = 0; i < 10; i++) im.create({ name: `Bulk ${i}` })
  ok('crea 10+ identities sin error con OZ_TIER=paid', im.list().length === 11)
  _restoreEnv()
}

// 4. update() patch genérico
section('update() patch')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const x = im.create({ name: 'X' })

  const renamed = im.update(x.id, { name: 'X-Renamed' })
  ok('update name persiste', renamed.name === 'X-Renamed')

  const recolored = im.update(x.id, { color: '#abcdef' })
  ok('update color persiste', recolored.color === '#abcdef')

  const ua = 'Mozilla/5.0 (Macintosh) Custom-OZ-Test'
  const uaSet = im.update(x.id, { userAgent: ua })
  ok('update userAgent persiste', uaSet.userAgent === ua)

  const uaCleared = im.update(x.id, { userAgent: '' })
  ok('userAgent vacío se persiste como null', uaCleared.userAgent === null)

  const ignored = im.update(x.id, { name: 'OK', isDefault: true })
  ok('update ignora fields no whitelisted (isDefault)', !ignored.isDefault)
}

// 5. Default rechaza userAgent (ADR 0010)
section('Default rechaza userAgent custom (ADR 0010)')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  const def = im.getDefault()
  const result = im.update(def.id, { userAgent: 'EvilUA' })
  ok(
    'Default.userAgent NO cambió',
    !result.userAgent,
    `después del update userAgent=${JSON.stringify(result.userAgent)}`,
  )
}

// 6. getSession devuelve defaultSession para Default, partition para otras
section('getSession() routing')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const def = im.getDefault()
  const x = im.create({ name: 'X' })

  const defSes = im.getSession(def.id)
  ok('Default → defaultSession (label="default")', defSes.__label === 'default')

  const xSes = im.getSession(x.id)
  ok(
    `Custom → partition session (label="persist:identity-${x.id}")`,
    xSes.__label === `persist:identity-${x.id}`,
  )

  // Cache check
  const xSes2 = im.getSession(x.id)
  ok('getSession(id) cachea (mismo objeto)', xSes === xSes2)
}

// 7. getSession aplica setUserAgent al crear con custom UA
section('getSession aplica setUserAgent al crear partition')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const customUA = 'Mozilla/5.0 OZ-CreateUA-Test'
  const x = im.create({ name: 'X', userAgent: customUA })

  setUACalls.length = 0
  im.getSession(x.id)

  const matches = setUACalls.filter((c) => c.ua === customUA)
  ok(
    'setUserAgent llamado con el UA custom al crear session',
    matches.length === 1,
    `setUACalls=${JSON.stringify(setUACalls)}`,
  )
}

// 8. update(userAgent) aplica setUserAgent en vivo a session cacheada
section('update(userAgent) en vivo sobre session cacheada')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const x = im.create({ name: 'X' })
  im.getSession(x.id) // cache

  setUACalls.length = 0
  const newUA = 'Mozilla/5.0 OZ-LiveUA-Test'
  im.update(x.id, { userAgent: newUA })

  const matches = setUACalls.filter((c) => c.ua === newUA)
  ok(
    'setUserAgent llamado en vivo al update',
    matches.length === 1,
    `setUACalls=${JSON.stringify(setUACalls)}`,
  )

  // Clear UA → debe llamar setUserAgent('')
  setUACalls.length = 0
  im.update(x.id, { userAgent: '' })
  const cleared = setUACalls.filter((c) => c.ua === '')
  ok(
    'setUserAgent("") al limpiar UA',
    cleared.length === 1,
    `setUACalls=${JSON.stringify(setUACalls)}`,
  )
}

// 9. Default getSession NO llama setUserAgent (ADR 0010 / 0003)
section('Default getSession NO llama setUserAgent')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  setUACalls.length = 0
  im.getSession(im.getDefault().id)
  const callsOnDefault = setUACalls.filter((c) => c.sessionLabel === 'default')
  ok(
    'defaultSession.setUserAgent NO se llama desde getSession',
    callsOnDefault.length === 0,
    `setUACalls=${JSON.stringify(setUACalls)}`,
  )
}

// 10. remove() no permite borrar Default
section('remove() protege Default')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const def = im.getDefault()
  const ok1 = im.remove(def.id)
  ok('remove(default) devuelve false', ok1 === false)
  ok('Default sigue presente', im.getDefault() && im.getDefault().isDefault)
}

// 11. Persistencia round-trip
section('Persistencia identities.json')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im1 = new IdentityManager()
  const a = im1.create({ name: 'Persist A', userAgent: 'UA-A' })
  const b = im1.create({ name: 'Persist B' })
  im1.update(b.id, { color: '#deadbe' })

  // Re-instantiate — _load() should pick up disk state.
  const im2 = new IdentityManager()
  const list = im2.list()
  ok('round-trip total === 3', list.length === 3)
  const aReloaded = list.find((i) => i.name === 'Persist A')
  const bReloaded = list.find((i) => i.name === 'Persist B')
  ok('Persist A.userAgent persistido', aReloaded && aReloaded.userAgent === 'UA-A')
  ok('Persist B.color persistido', bReloaded && bReloaded.color === '#deadbe')
}

// 12. H2 — setLocked + remove rejects locked
section('H2 setLocked: toggle persists + remove blocked when locked')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const a = im.create({ name: 'Locked A' })

  // create() default: not locked
  ok('new identity not locked by default', a.locked === false)

  // setLocked toggle
  const r1 = im.setLocked(a.id, true)
  ok('setLocked(true) returns identity', r1 && r1.id === a.id)
  ok('setLocked(true) sets locked=true', r1.locked === true)
  ok('list() reflects locked=true', im.get(a.id).locked === true)

  // remove blocked
  const removed = im.remove(a.id)
  ok('remove(locked) returns false', removed === false)
  ok('locked identity still present', im.get(a.id) !== null)

  // Unlock + remove
  const r2 = im.setLocked(a.id, false)
  ok('setLocked(false) sets locked=false', r2.locked === false)
  const removed2 = im.remove(a.id)
  ok('remove(unlocked) returns true', removed2 === true)
  ok('identity gone', im.get(a.id) === null)

  // setLocked on unknown id returns null
  ok('setLocked(unknown) returns null', im.setLocked('nope', true) === null)
}

// 13. H2 — locked persists across reload
section('H2 locked persists across reload')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im1 = new IdentityManager()
  const a = im1.create({ name: 'Vault Owner' })
  im1.setLocked(a.id, true)

  const im2 = new IdentityManager()
  const reloaded = im2.get(a.id)
  ok('reloaded identity exists', !!reloaded)
  ok('reloaded.locked === true', reloaded.locked === true)
  ok('reload still rejects remove', im2.remove(a.id) === false)
}

// 14. H3a — Identity.workspaceId field + listByWorkspace + sync hook
section('H3a Identity.workspaceId + listByWorkspace + sync hook')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const def = im.getDefault()

  ok("Default has workspaceId='general'", def.workspaceId === 'general')

  // Track sync hook calls.
  const syncCalls = []
  im.setWorkspaceSyncHook((op, identityId, fromWsId, toWsId) => {
    syncCalls.push({ op, identityId, fromWsId, toWsId })
  })

  const a = im.create({ name: 'Alpha', workspaceId: 'ws-1' })
  ok('create with workspaceId persists', a.workspaceId === 'ws-1')
  ok(
    "sync hook fired 'add' on create",
    syncCalls.length === 1 &&
      syncCalls[0].op === 'add' &&
      syncCalls[0].identityId === a.id &&
      syncCalls[0].toWsId === 'ws-1',
  )

  const b = im.create({ name: 'Beta' })
  ok("create without workspaceId defaults to 'general'", b.workspaceId === 'general')

  const c = im.create({ name: 'Gamma', workspaceId: 'ws-1' })
  const list1 = im.listByWorkspace('ws-1')
  ok(
    "listByWorkspace('ws-1') returns 2 identities",
    list1.length === 2 &&
      list1
        .map((i) => i.id)
        .sort()
        .join(',') === [a.id, c.id].sort().join(','),
  )
  ok(
    "listByWorkspace('general') has Default + Beta",
    im.listByWorkspace('general').length === 2,
  )
  ok("listByWorkspace('nope') returns []", im.listByWorkspace('nope').length === 0)
}

// 15. H3a — moveToWorkspace happy path + reject locked + reject Default
section('H3a moveToWorkspace')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const def = im.getDefault()
  const syncCalls = []
  im.setWorkspaceSyncHook((op, identityId, fromWsId, toWsId) => {
    syncCalls.push({ op, identityId, fromWsId, toWsId })
  })

  const a = im.create({ name: 'Movable', workspaceId: 'ws-1' })
  syncCalls.length = 0

  const r1 = im.moveToWorkspace(a.id, 'ws-2')
  ok('move ok=true', r1.ok === true && r1.from === 'ws-1' && r1.to === 'ws-2')
  ok('identity.workspaceId updated', im.get(a.id).workspaceId === 'ws-2')
  ok(
    "sync hook fired 'move' from ws-1 to ws-2",
    syncCalls.length === 1 &&
      syncCalls[0].op === 'move' &&
      syncCalls[0].fromWsId === 'ws-1' &&
      syncCalls[0].toWsId === 'ws-2',
  )

  // Same-ws move = noop (no sync fire)
  syncCalls.length = 0
  const r2 = im.moveToWorkspace(a.id, 'ws-2')
  ok('noop same workspace', r2.ok === true && r2.noop === true)
  ok('noop did not fire sync hook', syncCalls.length === 0)

  // Default identity rejects (pinned to general per D2)
  const r3 = im.moveToWorkspace(def.id, 'ws-1')
  ok(
    "Default rejects move with reason='default-pinned-to-general'",
    r3.ok === false && r3.reason === 'default-pinned-to-general',
  )

  // Locked identity rejects
  im.setLocked(a.id, true)
  const r4 = im.moveToWorkspace(a.id, 'ws-3')
  ok(
    "locked rejects with reason='identity-locked'",
    r4.ok === false && r4.reason === 'identity-locked',
  )

  // Unknown id
  const r5 = im.moveToWorkspace('nope', 'ws-3')
  ok(
    "unknown id rejects with reason='identity-not-found'",
    r5.ok === false && r5.reason === 'identity-not-found',
  )
}

// 16. H3a — sync hook fires 'remove' on identity removal
section("H3a sync hook fires 'remove' on remove()")
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  const im = new IdentityManager()
  const syncCalls = []
  im.setWorkspaceSyncHook((op, identityId, fromWsId) => {
    syncCalls.push({ op, identityId, fromWsId })
  })
  const a = im.create({ name: 'Removable', workspaceId: 'ws-9' })
  syncCalls.length = 0

  const removed = im.remove(a.id)
  ok('remove returns true', removed === true)
  ok(
    "sync hook fired 'remove' with fromWsId='ws-9'",
    syncCalls.length === 1 &&
      syncCalls[0].op === 'remove' &&
      syncCalls[0].identityId === a.id &&
      syncCalls[0].fromWsId === 'ws-9',
  )
}

// 17. H3a — defensive backfill of legacy identities without workspaceId
section('H3a defensive backfill on _load')
{
  const { IdentityManager } = freshIM({ OZ_TIER: 'paid' })
  // Write legacy-shaped identities.json (no workspaceId field) to disk.
  const fp = path.join(TEST_USERDATA, 'identities.json')
  fs.writeFileSync(
    fp,
    JSON.stringify([
      {
        id: 'default',
        name: 'Default',
        color: '#8a8a8a',
        fingerprintSeed: 'a',
        createdAt: 1,
        isDefault: true,
        // no workspaceId, no locked
      },
      {
        id: 'legacy-1',
        name: 'Legacy',
        color: '#ff0000',
        fingerprintSeed: 'b',
        createdAt: 2,
        // no workspaceId
      },
    ]),
  )
  const im = new IdentityManager()
  const list = im.list()
  ok(
    "legacy identities backfilled to workspaceId='general'",
    list.every((i) => i.workspaceId === 'general'),
  )
  ok('legacy data persisted', list.length === 2)
}

// D-3a 'changed' event tests + updatedAt backfill on _load were split into
// tests/identity-manager-events.smoketest.js (ADR 0005 — 500 LOC rule).

// ---------- Cleanup ----------------------------------------------------------

Module._load = originalLoad
Module._resolveFilename = originalResolve

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
