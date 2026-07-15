// OZ Browser — license-proxies smoke test (v2.0.0-alpha.100).
//   node tests/license-proxies.smoketest.js

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' } }
const originalLoad = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return originalLoad.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/license-proxies.js')]
const {
  applyManagedProxies,
  keyOf,
  MANAGED_TAG,
} = require('../browser/license-proxies.js')

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

// --- fakes ------------------------------------------------------------------
function makeProxyManager(seed = []) {
  let n = 0
  const items = seed.slice()
  return {
    _items: items,
    list: () => items.slice(),
    create: (spec) => {
      const p = { id: 'px' + ++n, ...spec }
      items.push(p)
      return p
    },
  }
}
function makeAssignment() {
  return {
    byIdentity: {},
    defaultStrategy: null,
    snapshot() {
      return { byIdentity: { ...this.byIdentity } }
    },
    setDefaultStrategy(s) {
      this.defaultStrategy = s
      return true
    },
    assignToIdentity(id, v) {
      if (v === null) delete this.byIdentity[id]
      else this.byIdentity[id] = v
      return true
    },
  }
}
function makeIdentities(ids) {
  return { list: () => ids.map((id) => ({ id })) }
}

const bundle = [
  {
    host: 'gate.decodo.com',
    port: 10001,
    username: 'user-x-session-a01',
    password: 'p',
    city: 'miami',
    country: 'US',
    tags: ['decodo'],
  },
  {
    host: 'gate.decodo.com',
    port: 10001,
    username: 'user-x-session-a02',
    password: 'p',
    city: 'miami',
  },
  { host: 'gate.decodo.com', port: 10001, username: 'user-x-session-a03', password: 'p' },
]

console.log('OZ Browser — license-proxies smoke test\n')

// validation guards
ok('no managers → not ok', applyManagedProxies({ proxies: bundle }).ok === false)
ok(
  'empty bundle → not ok',
  applyManagedProxies({
    proxyManager: makeProxyManager(),
    proxyAssignment: makeAssignment(),
    proxies: [],
  }).ok === false,
)

// fresh install: 3 proxies imported, 2 identities auto-assigned
{
  const pm = makeProxyManager()
  const pa = makeAssignment()
  const im = makeIdentities(['default', 'ig1'])
  const r = applyManagedProxies({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
    proxies: bundle,
  })
  ok('imports 3 proxies', r.ok && r.added === 3, JSON.stringify(r))
  ok(
    'all carry managed tag',
    pm._items.every((p) => p.tags.includes(MANAGED_TAG)),
  )
  ok('default strategy = auto-round-robin', pa.defaultStrategy === 'auto-round-robin')
  ok(
    'both identities assigned',
    r.assigned === 2 && pa.byIdentity.default && pa.byIdentity.ig1,
  )
  ok('distinct sessions kept distinct (same port)', pm._items.length === 3)
}

// idempotent: second run adds nothing, respects existing bindings
{
  const seed = bundle.map((p, i) => ({
    id: 'ex' + i,
    ...p,
    tags: [...(p.tags || []), MANAGED_TAG],
  }))
  const pm = makeProxyManager(seed)
  const pa = makeAssignment()
  pa.byIdentity.default = 'ex0' // user already bound this one
  const im = makeIdentities(['default', 'ig1'])
  const r = applyManagedProxies({
    proxyManager: pm,
    proxyAssignment: pa,
    identityManager: im,
    proxies: bundle,
  })
  ok('re-run adds 0 (dedup by host:port:username)', r.added === 0, JSON.stringify(r))
  ok('respects user binding on default', pa.byIdentity.default === 'ex0')
  ok('assigns only the unbound identity', r.assigned === 1 && !!pa.byIdentity.ig1)
}

// keyOf
ok(
  'keyOf distinguishes by username on same host:port',
  keyOf(bundle[0]) !== keyOf(bundle[1]),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.label}`)
  process.exit(1)
}
process.exit(0)
