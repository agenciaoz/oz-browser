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
  return { ...mod, _restoreEnv: () => {
    if (prevTier === undefined) delete process.env.OZ_TIER
    else process.env.OZ_TIER = prevTier
  } }
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
  ok('Default.userAgent ausente o null',
     list[0].userAgent === undefined || list[0].userAgent === null)
}

// 2. create() respeta cap de 3 (Default + 2 custom)
section('Cap free tier MAX_IDENTITIES_FREE=3')
{
  const { IdentityManager, IdentityCapError, MAX_IDENTITIES_FREE } = freshIM()
  ok('MAX_IDENTITIES_FREE exportado === 3', MAX_IDENTITIES_FREE === 3)
  ok('IdentityCapError exportado', typeof IdentityCapError === 'function')

  const im = new IdentityManager()
  const a = im.create({ name: 'Cliente A' })
  const b = im.create({ name: 'Cliente B' })
  ok('crea hasta llegar a 3 identities', im.list().length === 3)

  let threw = null
  try { im.create({ name: 'Cliente C' }) } catch (e) { threw = e }
  ok('4ta identity tira IdentityCapError',
     threw && threw.code === 'IDENTITY_CAP_REACHED',
     threw ? `code=${threw.code} message=${threw.message.slice(0, 80)}` : 'no throw')
  ok('error tiene current/max correctos',
     threw && threw.current === 3 && threw.max === 3)
}

// 3. OZ_TIER=paid bypassa cap
section('OZ_TIER=paid bypassa cap')
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
  ok('Default.userAgent NO cambió',
     !result.userAgent,
     `después del update userAgent=${JSON.stringify(result.userAgent)}`)
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
  ok(`Custom → partition session (label="persist:identity-${x.id}")`,
     xSes.__label === `persist:identity-${x.id}`)

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
  ok('setUserAgent llamado con el UA custom al crear session',
     matches.length === 1,
     `setUACalls=${JSON.stringify(setUACalls)}`)
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
  ok('setUserAgent llamado en vivo al update',
     matches.length === 1,
     `setUACalls=${JSON.stringify(setUACalls)}`)

  // Clear UA → debe llamar setUserAgent('')
  setUACalls.length = 0
  im.update(x.id, { userAgent: '' })
  const cleared = setUACalls.filter((c) => c.ua === '')
  ok('setUserAgent("") al limpiar UA',
     cleared.length === 1,
     `setUACalls=${JSON.stringify(setUACalls)}`)
}

// 9. Default getSession NO llama setUserAgent (ADR 0010 / 0003)
section('Default getSession NO llama setUserAgent')
{
  const { IdentityManager } = freshIM()
  const im = new IdentityManager()
  setUACalls.length = 0
  im.getSession(im.getDefault().id)
  const callsOnDefault = setUACalls.filter((c) => c.sessionLabel === 'default')
  ok('defaultSession.setUserAgent NO se llama desde getSession',
     callsOnDefault.length === 0,
     `setUACalls=${JSON.stringify(setUACalls)}`)
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

// ---------- Cleanup ----------------------------------------------------------

Module._load = originalLoad
Module._resolveFilename = originalResolve

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
