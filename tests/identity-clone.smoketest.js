// OZ Browser — identity-clone smoke test (E2-C-3 fase 1).
//
// Cómo correr:
//   cd oz-browser
//   node tests/identity-clone.smoketest.js
//
// Cubre:
//   - resolveCopyName: "X" → "X (copy)"
//   - resolveCopyName: "X (copy)" already taken → "X (copy 2)"
//   - resolveCopyName: cloning a copy strips the suffix → "X (copy 2)" (no nested)
//   - resolveCopyName: empty/missing srcName defensive
//   - cloneIdentity: not-found returns {ok:false, reason:'not-found'}
//   - cloneIdentity: no identity manager defensive
//   - cloneIdentity: basic clone (no inheritance) creates new identity
//   - cloneIdentity: explicit name overrides auto-gen
//   - cloneIdentity: sameFingerprint copies fingerprintSeed
//   - cloneIdentity: sameUA copies userAgent
//   - cloneIdentity: sameProxy inherits proxy assignment
//   - cloneIdentity: sameProxy without proxyAssignment instance is no-op
//   - cloneIdentity: sameProxy when source has no assignment is no-op
//   - cloneIdentity: workspaceId + color are always inherited
//   - cloneIdentity: locked source CAN be cloned (non-destructive op)
//   - cloneIdentity: default source CAN be cloned (clone is non-destructive)
//   - cloneIdentity: create() throws cap → returns {ok:false, reason:'IDENTITY_CAP_REACHED'}
//   - cloneIdentity: proxyAssignment.assignToIdentity throws → still ok=true (best-effort)

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-clone-'))
const TEST_LOGS = path.join(TEST_USERDATA, 'logs')
fs.mkdirSync(TEST_LOGS, { recursive: true })

const fakeApp = {
  getPath: (key) => (key === 'logs' ? TEST_LOGS : TEST_USERDATA),
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
  getVersion: () => '0.1.0-test',
}

const fakeElectron = { app: fakeApp }

const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, ...rest)
}

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

console.log('OZ Browser — identity-clone smoke test')

delete require.cache[require.resolve('../browser/identity-clone.js')]
delete require.cache[require.resolve('../browser/logger.js')]
const { cloneIdentity, resolveCopyName } = require('../browser/identity-clone.js')

// --- Helpers ----------------------------------------------------------------
function makeFakeIM({
  identities = [],
  throwOnCreate = null,
  capId = 0, // counter for generated ids
} = {}) {
  let nextIdNum = capId
  return {
    identities: identities.slice(),
    get(id) {
      return this.identities.find((i) => i.id === id) || null
    },
    list() {
      return this.identities.map((i) => ({ ...i }))
    },
    create(opts) {
      if (throwOnCreate) {
        const err = new Error(throwOnCreate.message || 'cap')
        err.code = throwOnCreate.code
        throw err
      }
      const id = `id-${++nextIdNum}`
      const newIdent = {
        id,
        name: opts.name,
        color: opts.color,
        userAgent: opts.userAgent || null,
        fingerprintSeed: opts.fingerprintSeed || `seed-${id}`,
        workspaceId: opts.workspaceId || 'general',
        locked: false,
        createdAt: Date.now(),
      }
      this.identities.push(newIdent)
      return newIdent
    },
  }
}

function makeFakePA({ assignments = {}, throwOnAssign = false } = {}) {
  return {
    assignments: { byIdentity: { ...assignments } },
    assignToIdentity(id, value) {
      if (throwOnAssign) throw new Error('proxy save fail')
      this.assignments.byIdentity[id] = value
    },
  }
}

// ---- 1. resolveCopyName ----------------------------------------------------
section('resolveCopyName')
ok('basic: "X" → "X (copy)"', resolveCopyName('Cliente A', []) === 'Cliente A (copy)')
ok(
  'collision: "X (copy)" exists → "X (copy 2)"',
  resolveCopyName('Cliente A', [{ name: 'Cliente A (copy)' }]) === 'Cliente A (copy 2)',
)
ok(
  'cloning a copy strips suffix → "X (copy 2)"',
  resolveCopyName('Cliente A (copy)', [{ name: 'Cliente A (copy)' }]) ===
    'Cliente A (copy 2)',
)
ok(
  'cloning a (copy 5) strips → "X (copy)" if X (copy) free',
  resolveCopyName('Cliente A (copy 5)', []) === 'Cliente A (copy)',
)
ok(
  'multi collisions → keeps incrementing',
  resolveCopyName('X', [{ name: 'X (copy)' }, { name: 'X (copy 2)' }]) === 'X (copy 3)',
)
ok('empty srcName defensive', typeof resolveCopyName('', []) === 'string')
ok(
  'undefined srcName defensive',
  typeof resolveCopyName(undefined, []) === 'string' &&
    resolveCopyName(undefined, []).startsWith('Identity'),
)
ok('null allIdentities defensive', resolveCopyName('Bob', null) === 'Bob (copy)')

// ---- 2. cloneIdentity defensive --------------------------------------------
section('cloneIdentity defensive')
{
  const r = cloneIdentity({ srcId: 'x', identityManager: null })
  ok('no identityManager → ok=false', r.ok === false)
  ok('reason no-identity-manager', r.reason === 'no-identity-manager')
}
{
  const im = makeFakeIM()
  const r = cloneIdentity({ srcId: 'nope', identityManager: im })
  ok('not-found → ok=false', r.ok === false)
  ok('reason not-found', r.reason === 'not-found')
}

// ---- 3. cloneIdentity basic ------------------------------------------------
section('cloneIdentity basic (no inheritance)')
{
  const im = makeFakeIM({
    identities: [
      {
        id: 'src',
        name: 'Source',
        color: '#ff0000',
        fingerprintSeed: 'srcseed',
        userAgent: 'CustomUA',
        workspaceId: 'marketing',
      },
    ],
  })
  const r = cloneIdentity({ srcId: 'src', opts: {}, identityManager: im })
  ok('ok=true', r.ok === true)
  ok('new identity has auto name', r.identity.name === 'Source (copy)')
  ok('color inherited', r.identity.color === '#ff0000')
  ok('workspaceId inherited', r.identity.workspaceId === 'marketing')
  ok(
    'fingerprintSeed FRESH (different)',
    r.identity.fingerprintSeed && r.identity.fingerprintSeed !== 'srcseed',
  )
  ok('userAgent NOT inherited (default)', !r.identity.userAgent)
  ok('inherited.fingerprint=false', r.inherited.fingerprint === false)
  ok('inherited.proxy=false', r.inherited.proxy === false)
  ok('inherited.ua=false', r.inherited.ua === false)
}

// ---- 4. cloneIdentity with explicit name ----------------------------------
section('cloneIdentity explicit name')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Source', color: '#abc', workspaceId: 'general' }],
  })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { name: '  My Custom Name  ' },
    identityManager: im,
  })
  ok('ok=true', r.ok === true)
  ok('name trimmed + used as-is', r.identity.name === 'My Custom Name')
}

// ---- 5. sameFingerprint ----------------------------------------------------
section('cloneIdentity sameFingerprint')
{
  const im = makeFakeIM({
    identities: [
      { id: 'src', name: 'Src', color: '#abc', fingerprintSeed: 'shared-seed-xyz' },
    ],
  })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameFingerprint: true },
    identityManager: im,
  })
  ok('ok=true', r.ok === true)
  ok(
    'fingerprintSeed copied from source',
    r.identity.fingerprintSeed === 'shared-seed-xyz',
  )
  ok('inherited.fingerprint=true', r.inherited.fingerprint === true)
}

// ---- 6. sameUA -------------------------------------------------------------
section('cloneIdentity sameUA')
{
  const im = makeFakeIM({
    identities: [
      {
        id: 'src',
        name: 'Src',
        color: '#abc',
        userAgent: 'Mozilla/5.0 SuperCustom',
      },
    ],
  })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameUA: true },
    identityManager: im,
  })
  ok('ok=true', r.ok === true)
  ok('userAgent copied', r.identity.userAgent === 'Mozilla/5.0 SuperCustom')
  ok('inherited.ua=true', r.inherited.ua === true)
}

// ---- 7. sameUA when source has no UA → no-op ------------------------------
section('cloneIdentity sameUA when source has no UA')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc', userAgent: null }],
  })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameUA: true },
    identityManager: im,
  })
  ok('ok=true', r.ok === true)
  ok('clone has no UA (source had none)', !r.identity.userAgent)
  ok('inherited.ua=false', r.inherited.ua === false)
}

// ---- 8. sameProxy ----------------------------------------------------------
section('cloneIdentity sameProxy')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc' }],
  })
  const pa = makeFakePA({ assignments: { src: 'proxy-123' } })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameProxy: true },
    identityManager: im,
    proxyAssignment: pa,
  })
  ok('ok=true', r.ok === true)
  ok('proxy assigned to new id', pa.assignments.byIdentity[r.identity.id] === 'proxy-123')
  ok('inherited.proxy=true', r.inherited.proxy === true)
  ok('proxyValue captured', r.inherited.proxyValue === 'proxy-123')
}

// ---- 9. sameProxy with auto-strategy assignment ---------------------------
section('cloneIdentity sameProxy with auto-strategy')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc' }],
  })
  const pa = makeFakePA({ assignments: { src: 'auto-round-robin' } })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameProxy: true },
    identityManager: im,
    proxyAssignment: pa,
  })
  ok('ok=true', r.ok === true)
  ok(
    'auto-strategy copied verbatim',
    pa.assignments.byIdentity[r.identity.id] === 'auto-round-robin',
  )
}

// ---- 10. sameProxy without proxyAssignment instance → no-op ---------------
section('cloneIdentity sameProxy without proxyAssignment dep')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc' }],
  })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameProxy: true },
    identityManager: im,
    // proxyAssignment intentionally omitted
  })
  ok('ok=true (no crash)', r.ok === true)
  ok('inherited.proxy=false (silent no-op)', r.inherited.proxy === false)
}

// ---- 11. sameProxy when source has no assignment → no-op ------------------
section('cloneIdentity sameProxy when source has no assignment')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc' }],
  })
  const pa = makeFakePA({ assignments: {} }) // no assignment for 'src'
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameProxy: true },
    identityManager: im,
    proxyAssignment: pa,
  })
  ok('ok=true', r.ok === true)
  ok('no assignment created for new id', !(r.identity.id in pa.assignments.byIdentity))
  ok('inherited.proxy=false', r.inherited.proxy === false)
}

// ---- 12. proxy assignToIdentity throws → still ok=true (best-effort) -----
section('cloneIdentity proxy save throws')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc' }],
  })
  const pa = makeFakePA({ assignments: { src: 'proxy-x' }, throwOnAssign: true })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameProxy: true },
    identityManager: im,
    proxyAssignment: pa,
  })
  ok('ok=true (clone succeeded)', r.ok === true)
  ok('inherited.proxy=false (assignment failed silently)', r.inherited.proxy === false)
}

// ---- 13. ALL inheritance flags together -----------------------------------
section('cloneIdentity ALL inheritance')
{
  const im = makeFakeIM({
    identities: [
      {
        id: 'src',
        name: 'Mega',
        color: '#abc',
        fingerprintSeed: 'mega-seed',
        userAgent: 'MegaUA',
        workspaceId: 'wsX',
      },
    ],
  })
  const pa = makeFakePA({ assignments: { src: 'proxy-mega' } })
  const r = cloneIdentity({
    srcId: 'src',
    opts: { sameFingerprint: true, sameProxy: true, sameUA: true },
    identityManager: im,
    proxyAssignment: pa,
  })
  ok('ok=true', r.ok === true)
  ok('FP copied', r.identity.fingerprintSeed === 'mega-seed')
  ok('UA copied', r.identity.userAgent === 'MegaUA')
  ok('proxy copied', pa.assignments.byIdentity[r.identity.id] === 'proxy-mega')
  ok('workspace inherited', r.identity.workspaceId === 'wsX')
  ok('color inherited', r.identity.color === '#abc')
}

// ---- 14. Locked source CAN be cloned (non-destructive) -------------------
section('cloneIdentity locked source')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc', locked: true }],
  })
  const r = cloneIdentity({ srcId: 'src', identityManager: im })
  ok('locked source clones successfully', r.ok === true)
  ok(
    'new identity is NOT locked by default',
    r.identity.locked === false || r.identity.locked == null,
  )
}

// ---- 15. Default source CAN be cloned ------------------------------------
section('cloneIdentity default source')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Default', color: '#abc', isDefault: true }],
  })
  const r = cloneIdentity({ srcId: 'src', identityManager: im })
  ok('default source clones successfully', r.ok === true)
  ok(
    'new identity is NOT default',
    !r.identity.isDefault || r.identity.isDefault === undefined,
  )
}

// ---- 16. cap reached → returns ok=false with reason ----------------------
section('cloneIdentity cap reached')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc' }],
    throwOnCreate: { code: 'IDENTITY_CAP_REACHED', message: 'free tier cap' },
  })
  const r = cloneIdentity({ srcId: 'src', identityManager: im })
  ok('ok=false on cap', r.ok === false)
  ok('reason === IDENTITY_CAP_REACHED', r.reason === 'IDENTITY_CAP_REACHED')
  ok('message captured', /cap/.test(r.message || ''))
}

// ---- 17. create throws without code → reason create-failed ---------------
section('cloneIdentity create throws generic')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Src', color: '#abc' }],
    throwOnCreate: { message: 'disk full' },
  })
  const r = cloneIdentity({ srcId: 'src', identityManager: im })
  ok('ok=false', r.ok === false)
  ok('reason create-failed', r.reason === 'create-failed')
}

// ---- 18. cloning twice → name collision avoidance integration ------------
section('cloneIdentity twice integration')
{
  const im = makeFakeIM({
    identities: [{ id: 'src', name: 'Bob', color: '#abc' }],
  })
  const r1 = cloneIdentity({ srcId: 'src', identityManager: im })
  const r2 = cloneIdentity({ srcId: 'src', identityManager: im })
  const r3 = cloneIdentity({ srcId: 'src', identityManager: im })
  ok('first clone "Bob (copy)"', r1.identity.name === 'Bob (copy)')
  ok('second clone "Bob (copy 2)"', r2.identity.name === 'Bob (copy 2)')
  ok('third clone "Bob (copy 3)"', r3.identity.name === 'Bob (copy 3)')
}

// ---- summary ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
Module._load = originalLoad
process.exit(0)
