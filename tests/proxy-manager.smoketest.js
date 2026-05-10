// OZ Browser — proxy-manager + proxy-handlers smoke test (1.8a).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-manager.smoketest.js
//
// Cubre:
//   - ProxyManager: create + validation (host/port/protocol), list, get,
//     update, remove, bulkAdd, persistence round-trip.
//   - Auto-Assign: random + round-robin (cursor cycles through assignable).
//   - Health helpers: recordHealthSuccess + recordHealthFailure (auto-disable
//     after 3 fails, auto-re-enable on success).
//   - listAssignable filters out isDisabled and isActive=false.
//   - handlers wrappers wire broadcasts + logging.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-proxy-'))
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
  delete require.cache[require.resolve('../browser/proxy-handlers.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { ProxyManager } = require('../browser/proxy-manager.js')
  const { buildProxyHandlers } = require('../browser/proxy-handlers.js')
  const pm = new ProxyManager()
  const broadcasts = []
  const browser = {
    proxyManager: pm,
    broadcastToWebUI(channel) {
      broadcasts.push(channel)
    },
  }
  const handlers = buildProxyHandlers(browser)
  return { pm, browser, handlers, broadcasts }
}

console.log('OZ Browser — proxy-manager smoke test')
console.log(`Test userData: ${TEST_USERDATA}`)

// 1. create + validation
section('create: validation + happy path')
{
  const { pm } = freshSetup()
  const ok1 = pm.create({
    host: 'us-pr.oxylabs.io',
    port: 10001,
    username: 'u',
    password: 'p',
  })
  ok('happy path returns proxy', !!ok1.id)
  ok('protocol defaults to https', ok1.protocol === 'https')
  ok('isActive default true', ok1.isActive === true)
  ok('isDisabled default false', ok1.isDisabled === false)
  ok('failureCount default 0', ok1.failureCount === 0)
  ok('bandwidth default 0', ok1.bandwidthBytesUsed === 0)
  ok('name auto from host:port', ok1.name === 'https://us-pr.oxylabs.io:10001')

  const r1 = pm.create({ host: 'x.com' })
  ok('missing port → INVALID_PORT', r1.__error && r1.__error.code === 'INVALID_PORT')

  const r2 = pm.create({ port: 80 })
  ok('missing host → MISSING_HOST', r2.__error && r2.__error.code === 'MISSING_HOST')

  const r3 = pm.create({ host: 'x.com', port: 999999 })
  ok('out-of-range port → INVALID_PORT', r3.__error && r3.__error.code === 'INVALID_PORT')

  const r4 = pm.create({ host: 'x.com', port: 80, protocol: 'gopher' })
  ok(
    'bad protocol → INVALID_PROTOCOL',
    r4.__error && r4.__error.code === 'INVALID_PROTOCOL',
  )
}

// 2. list / get / update / remove
section('CRUD + list filtering')
{
  const { pm } = freshSetup()
  const a = pm.create({ name: 'A', host: 'a.com', port: 80 })
  const b = pm.create({ name: 'B', host: 'b.com', port: 81 })
  const c = pm.create({ name: 'C', host: 'c.com', port: 82, isActive: false })
  ok('list = 3', pm.list().length === 3)
  ok('listAssignable = 2 (excludes inactive)', pm.listAssignable().length === 2)

  const u = pm.update(a.id, { name: 'A renamed', port: 8080 })
  ok('update name', u.name === 'A renamed')
  ok('update port', u.port === 8080)

  const u2 = pm.update(a.id, { port: 'invalid' })
  ok('invalid port silently ignored', u2.port === 8080)

  const u3 = pm.update(a.id, { protocol: 'gopher' })
  ok('invalid protocol silently ignored', u3.protocol !== 'gopher')

  ok('remove ok', pm.remove(b.id) === true)
  ok('list = 2', pm.list().length === 2)
  ok('remove unknown false', pm.remove('nope') === false)

  ok('get by id', pm.get(c.id).name === 'C')
  ok('get unknown null', pm.get('nope') === null)
}

// 3. persistence round-trip
section('persistence: write then re-instantiate')
{
  const { ProxyManager } = freshSetup() ? require('../browser/proxy-manager.js') : null // freshSetup also returns ProxyManager indirectly via cached require
  void ProxyManager
  // We re-require to ensure file load
  delete require.cache[require.resolve('../browser/proxy-manager.js')]
  const { ProxyManager: PM } = require('../browser/proxy-manager.js')
  const pm1 = new PM()
  // freshSetup just reset; pm1 starts empty
  pm1.create({ name: 'persist-1', host: 'p1.com', port: 80 })
  pm1.create({ name: 'persist-2', host: 'p2.com', port: 8080, protocol: 'socks5' })
  delete require.cache[require.resolve('../browser/proxy-manager.js')]
  const { ProxyManager: PM2 } = require('../browser/proxy-manager.js')
  const pm2 = new PM2()
  ok('round-trip count = 2', pm2.list().length === 2)
  const p1 = pm2.list().find((p) => p.name === 'persist-1')
  ok('persist-1 survives', !!p1 && p1.host === 'p1.com')
  const p2 = pm2.list().find((p) => p.name === 'persist-2')
  ok('protocol socks5 preserved', p2.protocol === 'socks5')
}

// 4. autoAssign
section('autoAssign: random + round-robin')
{
  const { pm } = freshSetup()
  ok('empty pool returns null', pm.autoAssign('random') === null)
  pm.create({ name: 'a', host: 'a.com', port: 80 })
  pm.create({ name: 'b', host: 'b.com', port: 80 })
  pm.create({ name: 'c', host: 'c.com', port: 80 })

  const seen = new Set()
  for (let i = 0; i < 30; i++) seen.add(pm.autoAssign('random').id)
  ok('random hits ≥2 different proxies in 30 picks', seen.size >= 2)

  const r1 = pm.autoAssign('round-robin').id
  const r2 = pm.autoAssign('round-robin').id
  const r3 = pm.autoAssign('round-robin').id
  const r4 = pm.autoAssign('round-robin').id
  ok('round-robin cycles through 3', r1 !== r2 && r2 !== r3 && r1 !== r3)
  ok('round-robin wraps to first', r4 === r1)
}

// 5. autoAssign skips disabled / inactive
section('autoAssign: skips disabled and inactive')
{
  const { pm } = freshSetup()
  const a = pm.create({ name: 'a', host: 'a.com', port: 80 })
  const b = pm.create({ name: 'b', host: 'b.com', port: 80 })
  pm.update(b.id, { isActive: false })
  for (let i = 0; i < 5; i++) {
    const picked = pm.autoAssign('random')
    ok(`pick ${i + 1} is a (b is inactive)`, picked.id === a.id)
  }
  // Disable a too
  pm.update(a.id, { isDisabled: true })
  ok('all disabled/inactive → null', pm.autoAssign('random') === null)
}

// 6. health record success/failure + auto-disable
section('health: success + failure + auto-disable')
{
  const { pm } = freshSetup()
  const a = pm.create({ name: 'a', host: 'a.com', port: 80 })

  // Two failures don't disable
  pm.recordHealthFailure(a.id, { reason: 'timeout' })
  pm.recordHealthFailure(a.id, { reason: 'timeout' })
  ok('after 2 fails not disabled', pm.get(a.id).isDisabled === false)
  ok('failureCount === 2', pm.get(a.id).failureCount === 2)

  // Third fail → auto-disable
  const r = pm.recordHealthFailure(a.id, { reason: 'timeout' })
  ok('autoDisabled returned', r.autoDisabled === true)
  ok('after 3 fails isDisabled=true', pm.get(a.id).isDisabled === true)
  ok('not in assignable pool', pm.listAssignable().length === 0)

  // Success resets and re-enables
  pm.recordHealthSuccess(a.id, { latencyMs: 120, ip: '1.2.3.4' })
  ok('failureCount reset', pm.get(a.id).failureCount === 0)
  ok('auto-re-enabled', pm.get(a.id).isDisabled === false)
  ok('latency recorded', pm.get(a.id).lastLatencyMs === 120)
  ok('ip recorded', pm.get(a.id).lastTestedIp === '1.2.3.4')
  ok('back in assignable pool', pm.listAssignable().length === 1)

  // 4th fail also doesn't double-fire autoDisabled (counter goes 1→2→3)
  pm.recordHealthFailure(a.id)
  pm.recordHealthFailure(a.id)
  const r4 = pm.recordHealthFailure(a.id)
  ok('autoDisabled fires once again at 3', r4.autoDisabled === true)
}

// 7. handlers wrappers
section('handlers: broadcasts + autoAssign passthrough')
{
  const { handlers, broadcasts } = freshSetup()
  const r = handlers.create({ host: 'h.com', port: 80 })
  ok('create returns proxy', !!r.id)
  ok('broadcast on create', broadcasts.includes('oz:proxies:changed'))

  const broadCount = broadcasts.length
  handlers.update(r.id, { name: 'renamed' })
  ok('broadcast on update', broadcasts.length > broadCount)

  ok('handler list = 1', handlers.list().length === 1)
  ok('handler listAssignable = 1', handlers.listAssignable().length === 1)
  ok('handler get works', handlers.get(r.id).name === 'renamed')

  // setActive(false) auto-clears isDisabled? No — only true clears.
  handlers.update(r.id, { isDisabled: true })
  const reactivated = handlers.setActive(r.id, true)
  ok('setActive(true) clears isDisabled', reactivated.isDisabled === false)

  ok('autoAssign returns proxy', handlers.autoAssign('random').id === r.id)
  ok('handler remove ok', handlers.remove(r.id) === true)
}

// 8. bulkAdd
section('bulkAdd: skips invalid items')
{
  const { pm } = freshSetup()
  const out = pm.bulkAdd([
    { host: 'a.com', port: 80 },
    { host: 'b.com', port: 81 },
    { /* missing host */ port: 82 }, // skip
    { host: 'c.com', port: 'invalid' }, // skip
    { host: 'd.com', port: 83, protocol: 'socks5' },
  ])
  ok('bulkAdd returns 3 valid', out.length === 3)
  ok('list has 3', pm.list().length === 3)
  ok(
    'socks5 preserved',
    pm.list().some((p) => p.protocol === 'socks5'),
  )
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
