// OZ Browser — identity-handlers auto-assign proxy on create smoke test
// (v2.0.0-alpha.22).
//
// Cómo correr:
//   cd oz-browser
//   node tests/identity-handlers-autoassign.smoketest.js
//
// Cubre el hook agregado en identity-handlers.create() que auto-asigna un
// proxy al crear identidad cuando:
//   - opts.proxyId no fue pasado (UI no eligió uno)
//   - identity no es default
//   - settings.privacy.autoAssignProxyOnCreate !== false
//   - hay proxies enabled en el pool (listAssignable().length > 0)

const Module = require('module')

// Need to stub electron because identity-handlers requires ./logger which
// requires electron.app. We don't actually touch userData here — the
// handlers themselves only call inject'd managers.
const fakeElectron = {
  app: {
    getPath: () => '/tmp',
    getName: () => 'OZ Browser Test',
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

const { buildIdentityHandlers } = require('../browser/identity-handlers.js')

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

function makeBrowser({ enabledProxies = [], settings }) {
  const assignCalls = []
  const autoAssignCalls = []
  const broadcasts = []
  const createCalls = []

  // 1 default + create() always returns a fresh identity each call.
  let _seq = 0
  const browser = {
    identityManager: {
      create(opts) {
        createCalls.push({ ...opts })
        _seq += 1
        return {
          id: 'i' + _seq,
          name: opts.name || 'New Identity',
          workspaceId: opts.workspaceId || 'general',
          isDefault: false,
        }
      },
    },
    proxyManager: {
      listAssignable() {
        return enabledProxies.slice()
      },
      autoAssign(strategy) {
        autoAssignCalls.push(strategy)
        return enabledProxies[0] || null
      },
    },
    proxyAssignment: {
      assignToIdentity(identityId, value) {
        assignCalls.push({ identityId, value })
        return true
      },
    },
    settingsManager: {
      get(section) {
        if (settings && settings[section] !== undefined) {
          return { ...settings[section] }
        }
        return null
      },
    },
    antiLogout: null,
    getFocusedWindow: () => ({ workspaceId: 'general' }),
    broadcastToWebUI(channel, payload) {
      broadcasts.push({ channel, payload })
    },
    activeIdentityId: null,
  }
  return { browser, assignCalls, autoAssignCalls, broadcasts, createCalls }
}

console.log('OZ Browser — identity-handlers auto-assign smoke test')

// ============================================================================
console.log('\n1. happy path — pool=2, no proxyId passed, setting ON → auto-assigns')
// ============================================================================
{
  const env = makeBrowser({
    enabledProxies: [
      { id: 'p1', isActive: true, isDisabled: false },
      { id: 'p2', isActive: true, isDisabled: false },
    ],
    settings: { privacy: { autoAssignProxyOnCreate: true } },
  })
  const h = buildIdentityHandlers(env.browser)
  const ident = h.create({ name: 'Test1' })
  ok('create returned an identity', ident && ident.id)
  ok('autoAssign was called exactly once', env.autoAssignCalls.length === 1)
  ok(
    'assignToIdentity was called with newly created identity',
    env.assignCalls.length === 1 && env.assignCalls[0].identityId === ident.id,
  )
  ok('assigned proxyId came from auto-assign (p1)', env.assignCalls[0].value === 'p1')
  ok(
    'broadcasts include oz:proxies:changed (post-assign)',
    env.broadcasts.some((b) => b.channel === 'oz:proxies:changed'),
  )
}

// ============================================================================
console.log('\n2. caller passed proxyId explicitly → NO auto-assign')
// ============================================================================
{
  const env = makeBrowser({
    enabledProxies: [{ id: 'p1', isActive: true, isDisabled: false }],
    settings: { privacy: { autoAssignProxyOnCreate: true } },
  })
  const h = buildIdentityHandlers(env.browser)
  h.create({ name: 'Test2', proxyId: 'p9' })
  ok(
    'autoAssign was NOT called (caller supplied proxyId)',
    env.autoAssignCalls.length === 0,
  )
  ok(
    'assignToIdentity was NOT called (caller picked their own proxy)',
    env.assignCalls.length === 0,
  )
}

// ============================================================================
console.log('\n3. empty pool → no auto-assign, no crash')
// ============================================================================
{
  const env = makeBrowser({
    enabledProxies: [],
    settings: { privacy: { autoAssignProxyOnCreate: true } },
  })
  const h = buildIdentityHandlers(env.browser)
  const ident = h.create({ name: 'Test3' })
  ok('create still succeeded with empty pool', ident && ident.id)
  ok('autoAssign was NOT called (pool empty)', env.autoAssignCalls.length === 0)
  ok('assignToIdentity was NOT called', env.assignCalls.length === 0)
}

// ============================================================================
console.log('\n4. setting OFF → no auto-assign even with proxies in pool')
// ============================================================================
{
  const env = makeBrowser({
    enabledProxies: [{ id: 'p1', isActive: true, isDisabled: false }],
    settings: { privacy: { autoAssignProxyOnCreate: false } },
  })
  const h = buildIdentityHandlers(env.browser)
  h.create({ name: 'Test4' })
  ok('autoAssign was NOT called (setting OFF)', env.autoAssignCalls.length === 0)
  ok('assignToIdentity was NOT called', env.assignCalls.length === 0)
}

// ============================================================================
console.log('\n5. proxyManager missing → no crash, no auto-assign')
// ============================================================================
{
  const env = makeBrowser({
    enabledProxies: [],
    settings: { privacy: { autoAssignProxyOnCreate: true } },
  })
  env.browser.proxyManager = null
  const h = buildIdentityHandlers(env.browser)
  let ident = null
  let threw = false
  try {
    ident = h.create({ name: 'Test5' })
  } catch (_e) {
    threw = true
  }
  ok('create did NOT throw when proxyManager null', !threw)
  ok('identity still created', ident && ident.id)
  ok('no assignToIdentity call', env.assignCalls.length === 0)
}

// ============================================================================
console.log('\n6. settingsManager missing → defaults to ON, auto-assigns')
// ============================================================================
{
  const env = makeBrowser({
    enabledProxies: [{ id: 'p1', isActive: true, isDisabled: false }],
    settings: null,
  })
  env.browser.settingsManager = null
  const h = buildIdentityHandlers(env.browser)
  h.create({ name: 'Test6' })
  ok('autoAssign was called (no settings → default ON)', env.autoAssignCalls.length === 1)
  ok('assignToIdentity was called', env.assignCalls.length === 1)
}

// ============================================================================
console.log('\n7. default identity carveout — isDefault=true → no auto-assign')
// ============================================================================
{
  const env = makeBrowser({
    enabledProxies: [{ id: 'p1', isActive: true, isDisabled: false }],
    settings: { privacy: { autoAssignProxyOnCreate: true } },
  })
  // Replace create to return isDefault:true so we exercise the carveout.
  env.browser.identityManager.create = (opts) => ({
    id: 'idef',
    name: opts.name,
    workspaceId: opts.workspaceId || 'general',
    isDefault: true,
  })
  const h = buildIdentityHandlers(env.browser)
  h.create({ name: 'Default' })
  ok('autoAssign was NOT called for default identity', env.autoAssignCalls.length === 0)
}

// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
