// OZ Browser — proxy-assignment smoke test (1.8b).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-assignment.smoketest.js
//
// Cubre:
//   - assignToIdentity / assignToWorkspace / setDefaultStrategy persistence.
//   - resolve() jerarquía Identity > Workspace > defaultStrategy.
//   - 'auto-random' / 'auto-round-robin' materializan vía ProxyManager.
//   - Concrete proxy id que está disabled o inactive → null en resolve.
//   - clearByProxyId(proxyId) borra todas las references.
//   - toProxyRulesString para http/https/socks5.
//   - Snapshot.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-pa-'))
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
    getVersion: () => 'test',
    on() {},
    whenReady: () => Promise.resolve(),
  },
}
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

function freshSetup() {
  for (const f of fs.readdirSync(TEST_USERDATA)) {
    if (f === 'logs') continue
    fs.rmSync(path.join(TEST_USERDATA, f), { recursive: true, force: true })
  }
  delete require.cache[require.resolve('../browser/proxy-manager.js')]
  delete require.cache[require.resolve('../browser/proxy-assignment.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { ProxyManager } = require('../browser/proxy-manager.js')
  const {
    ProxyAssignment,
    toProxyRulesString,
  } = require('../browser/proxy-assignment.js')
  const pm = new ProxyManager()
  const pa = new ProxyAssignment({ proxyManager: pm })
  return { pm, pa, toProxyRulesString }
}

console.log('OZ Browser — proxy-assignment smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. assign + resolve concrete proxy by identity
section('resolve: concrete proxy via identity')
{
  const { pm, pa } = freshSetup()
  const a = pm.create({ name: 'A', host: 'a.com', port: 80 })
  pa.assignToIdentity('id-1', a.id)
  const r = pa.resolve({ identityId: 'id-1' })
  ok('resolved to A', !!r && r.id === a.id)
  ok('no identity → null', pa.resolve({ identityId: 'id-2' }) === null)
}

// 2. resolve falls back to workspace
section('resolve: hierarchy Identity > Workspace')
{
  const { pm, pa } = freshSetup()
  const a = pm.create({ name: 'A', host: 'a.com', port: 80 })
  const b = pm.create({ name: 'B', host: 'b.com', port: 80 })
  pa.assignToIdentity('id-1', a.id)
  pa.assignToWorkspace('ws-1', b.id)

  // Identity wins over workspace.
  const r1 = pa.resolve({ identityId: 'id-1', workspaceId: 'ws-1' })
  ok('identity wins → A', r1.id === a.id)

  // No identity assignment → workspace.
  const r2 = pa.resolve({ identityId: 'id-2', workspaceId: 'ws-1' })
  ok('falls back to workspace → B', r2.id === b.id)

  // Neither → null
  const r3 = pa.resolve({ identityId: 'id-2', workspaceId: 'ws-2' })
  ok('no match → null', r3 === null)
}

// 3. defaultStrategy fallback
section('resolve: defaultStrategy fallback')
{
  const { pm, pa } = freshSetup()
  pm.create({ name: 'a', host: 'a.com', port: 80 })
  pm.create({ name: 'b', host: 'b.com', port: 80 })
  pa.setDefaultStrategy('auto-round-robin')

  const r1 = pa.resolve({ identityId: 'id-x', workspaceId: 'ws-x' })
  ok('default strategy returns proxy', !!r1)
  const r2 = pa.resolve({})
  ok('default strategy with empty ctx returns proxy', !!r2)
}

// 4. auto-random / auto-round-robin per-identity
section('resolve: auto-* materializes')
{
  const { pm, pa } = freshSetup()
  const a = pm.create({ name: 'a', host: 'a.com', port: 80 })
  pm.create({ name: 'b', host: 'b.com', port: 80 })
  pa.assignToIdentity('id-1', 'auto-round-robin')
  const seq = []
  for (let i = 0; i < 4; i++) seq.push(pa.resolve({ identityId: 'id-1' }).id)
  ok('round-robin cycles', seq[0] !== seq[1])
  ok('round-robin wraps', seq[2] === seq[0])

  pa.assignToIdentity('id-2', 'auto-random')
  const r = pa.resolve({ identityId: 'id-2' })
  ok('auto-random returns assignable proxy', !!r && [a.id, seq[0], seq[1]].includes(r.id))
}

// 5. Concrete proxy disabled → null
section('resolve: disabled/inactive proxies → null')
{
  const { pm, pa } = freshSetup()
  const a = pm.create({ name: 'a', host: 'a.com', port: 80 })
  pa.assignToIdentity('id-1', a.id)
  pm.update(a.id, { isDisabled: true })
  ok('disabled proxy not resolved', pa.resolve({ identityId: 'id-1' }) === null)

  pm.update(a.id, { isDisabled: false, isActive: false })
  ok('inactive proxy not resolved', pa.resolve({ identityId: 'id-1' }) === null)
}

// 6. clearByProxyId
section('clearByProxyId: cascade-cleans bindings')
{
  const { pm, pa } = freshSetup()
  const a = pm.create({ name: 'a', host: 'a.com', port: 80 })
  const b = pm.create({ name: 'b', host: 'b.com', port: 80 })
  pa.assignToIdentity('id-1', a.id)
  pa.assignToIdentity('id-2', a.id) // same proxy on two identities
  pa.assignToWorkspace('ws-1', a.id)
  pa.assignToIdentity('id-3', b.id) // unrelated

  const changed = pa.clearByProxyId(a.id)
  ok('clearByProxyId returned true', changed === true)
  ok('id-1 cleared', pa.resolve({ identityId: 'id-1' }) === null)
  ok('id-2 cleared', pa.resolve({ identityId: 'id-2' }) === null)
  ok('ws-1 cleared', pa.resolve({ workspaceId: 'ws-1' }) === null)
  ok('id-3 → b survives', pa.resolve({ identityId: 'id-3' }).id === b.id)
}

// 7. assignTo* with null/undefined removes the binding
section('assignToIdentity(null) clears the binding')
{
  const { pm, pa } = freshSetup()
  const a = pm.create({ name: 'a', host: 'a.com', port: 80 })
  pa.assignToIdentity('id-1', a.id)
  ok('initially resolves', pa.resolve({ identityId: 'id-1' }).id === a.id)
  pa.assignToIdentity('id-1', null)
  ok('null clears', pa.resolve({ identityId: 'id-1' }) === null)
}

// 8. persistence round-trip
section('persistence round-trip')
{
  const { pm, pa } = freshSetup()
  const a = pm.create({ name: 'persist-a', host: 'a.com', port: 80 })
  pa.assignToIdentity('id-1', a.id)
  pa.assignToWorkspace('ws-1', 'auto-random')
  pa.setDefaultStrategy('auto-round-robin')

  delete require.cache[require.resolve('../browser/proxy-assignment.js')]
  const { ProxyAssignment } = require('../browser/proxy-assignment.js')
  const pa2 = new ProxyAssignment({ proxyManager: pm })
  ok('byIdentity round-trip', pa2.resolve({ identityId: 'id-1' }).id === a.id)
  const snap = pa2.snapshot()
  ok('byWorkspace persisted', snap.byWorkspace['ws-1'] === 'auto-random')
  ok('defaultStrategy persisted', snap.defaultStrategy === 'auto-round-robin')
}

// 9. setDefaultStrategy validation
section('setDefaultStrategy: only auto-* or null accepted')
{
  const { pa } = freshSetup()
  ok('auto-random ok', pa.setDefaultStrategy('auto-random') === true)
  ok('auto-round-robin ok', pa.setDefaultStrategy('auto-round-robin') === true)
  ok('null clears', pa.setDefaultStrategy(null) === true)
  ok('invalid rejected', pa.setDefaultStrategy('bogus') === false)
}

// 10. toProxyRulesString
section('toProxyRulesString: per protocol')
{
  const { toProxyRulesString } = freshSetup()
  ok(
    'http → host:port',
    toProxyRulesString({ protocol: 'http', host: 'a.com', port: 80 }) === 'a.com:80',
  )
  ok(
    'https → host:port (Electron treats them the same)',
    toProxyRulesString({ protocol: 'https', host: 'a.com', port: 443 }) === 'a.com:443',
  )
  ok(
    'socks5 → socks5://host:port',
    toProxyRulesString({ protocol: 'socks5', host: 'a.com', port: 1080 }) ===
      'socks5://a.com:1080',
  )
  ok('null → null', toProxyRulesString(null) === null)
}

// ---------- Cleanup ---------------------------------------------------------

Module._load = originalLoad

console.log(`\n=== ${passed} passed · ${failed} failed ===`)
if (failed > 0) {
  console.log('\nFailures:')
  for (const f of failures)
    console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
  process.exit(1)
}
process.exit(0)
