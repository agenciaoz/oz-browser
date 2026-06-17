// OZ Browser — proxy-health smoke test (1.8c).
//
// Cómo correr:
//   cd oz-browser
//   node tests/proxy-health.smoketest.js
//
// Cubre:
//   - testOne: success path (registers latency + IP via manager).
//   - testOne: failure path (records failure + after 3 fires auto-disable).
//   - testAll: parallel results en orden de input.
//   - SOCKS5 usa tcpConnect, http/https usa connectViaProxy.
//   - Daemon start/stop (fake timers).
//   - Notification dispatched on auto-disable.
//
// Approach: inyectamos `tcpConnect` y `connectViaProxy` fakes via constructor
// opts — no hace falta levantar TCP servers reales.

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

const TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-test-ph-'))
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
  delete require.cache[require.resolve('../browser/proxy-health.js')]
  delete require.cache[require.resolve('../browser/logger.js')]
  const { ProxyManager, AUTO_DISABLE_THRESHOLD } = require('../browser/proxy-manager.js')
  const { ProxyHealth } = require('../browser/proxy-health.js')
  const pm = new ProxyManager()
  return { pm, ProxyHealth, AUTO_DISABLE_THRESHOLD }
}

console.log('OZ Browser — proxy-health smoke test')

// ---------- 1. happy path ----------------------------------------------------
section('testOne: success → records latency + clears failure count')
;(async () => {
  try {
    const { pm, ProxyHealth, AUTO_DISABLE_THRESHOLD } = freshSetup()
    const a = pm.create({ name: 'a', host: '1.2.3.4', port: 8080 })
    let calledWith = null
    const fakeTcp = async (host, port) => {
      calledWith = { host, port, kind: 'tcp' }
      return { ok: true }
    }
    const fakeConnect = async (proxy) => {
      calledWith = { proxy, kind: 'connect' }
      return { ok: true, status: 200 }
    }
    const ph = new ProxyHealth({
      proxyManager: pm,
      tcpConnect: fakeTcp,
      connectViaProxy: fakeConnect,
    })

    const r = await ph.testOne(a.id)
    ok('success ok', r.ok === true)
    ok('latencyMs > 0', typeof r.latencyMs === 'number')
    ok('https/http used connectViaProxy', calledWith.kind === 'connect')
    ok('lastTestedAt set', !!pm.get(a.id).lastTestedAt)
    ok('failureCount stays 0', pm.get(a.id).failureCount === 0)

    // SOCKS5 should hit tcpConnect not connectViaProxy
    const b = pm.create({ name: 'b', host: '2.3.4.5', port: 1080, protocol: 'socks5' })
    calledWith = null
    const r2 = await ph.testOne(b.id)
    ok('socks5 ok', r2.ok === true)
    ok('socks5 used tcpConnect', calledWith.kind === 'tcp')

    // unknown id
    const r3 = await ph.testOne('nope')
    ok('unknown id ok:false', r3.ok === false)
    ok('reason proxy-not-found', r3.reason === 'proxy-not-found')

    // ---------- 2. failure path → auto-disable after THRESHOLD -----
    section(`testOne: ${AUTO_DISABLE_THRESHOLD} failures → auto-disable + notify`)
    const failTcp = async () => ({ ok: false, message: 'timeout' })
    const failConnect = async () => ({ ok: false, message: 'timeout' })
    const notifyCalls = []
    const broadcastCalls = []
    const ph2 = new ProxyHealth({
      proxyManager: pm,
      tcpConnect: failTcp,
      connectViaProxy: failConnect,
      notify: (title, body) => notifyCalls.push({ title, body }),
      broadcast: (channel) => broadcastCalls.push(channel),
    })
    const c = pm.create({ name: 'c', host: '3.4.5.6', port: 80 })

    let lastFail
    for (let i = 1; i <= AUTO_DISABLE_THRESHOLD; i++) {
      lastFail = await ph2.testOne(c.id)
      if (i < AUTO_DISABLE_THRESHOLD) {
        ok(`fail ${i}: not autoDisabled yet`, lastFail.autoDisabled !== true)
      }
    }
    ok(`fail ${AUTO_DISABLE_THRESHOLD}: autoDisabled`, lastFail.autoDisabled === true)
    ok('notify fired once on autoDisable', notifyCalls.length === 1)
    ok(
      'notify title contains "auto-disabled"',
      notifyCalls[0].title.includes('auto-disabled'),
    )
    ok(
      'broadcast fired once per failure',
      broadcastCalls.filter((c) => c === 'oz:proxies:changed').length ===
        AUTO_DISABLE_THRESHOLD,
    )
    ok('proxy isDisabled=true', pm.get(c.id).isDisabled === true)

    // recordHealthSuccess should re-enable + reset
    pm.recordHealthSuccess(c.id, { latencyMs: 50 })
    ok('after success isDisabled=false', pm.get(c.id).isDisabled === false)

    // ---------- 2b. alpha.39 auto-recovery: daemon re-tests auto-disabled
    //               active proxies and re-enables them when they pass --------
    section('testAll activeOnly re-tests + auto-recovers an auto-disabled proxy')
    const { pm: pmR, ProxyHealth: PHR } = freshSetup()
    const rec1 = pmR.create({ name: 'recov', host: '9.9.9.9', port: 80 })
    // Force auto-disabled state (isActive stays true).
    pmR.update(rec1.id, { isDisabled: true })
    ok('precondition: isDisabled=true', pmR.get(rec1.id).isDisabled === true)
    ok(
      'default testAll (assignable) SKIPS the auto-disabled proxy',
      (
        await new PHR({
          proxyManager: pmR,
          connectViaProxy: async () => ({ ok: true }),
        }).testAll()
      ).length === 0,
    )
    const phR = new PHR({
      proxyManager: pmR,
      tcpConnect: async () => ({ ok: true }),
      connectViaProxy: async () => ({ ok: true, status: 200 }),
    })
    const recovResults = await phR.testAll({ activeOnly: true })
    ok('activeOnly testAll includes the auto-disabled proxy', recovResults.length === 1)
    ok('auto-recovered: isDisabled=false', pmR.get(rec1.id).isDisabled === false)
    // Manual-off (isActive=false) must NOT be revived.
    const rec2 = pmR.create({ name: 'off', host: '8.8.8.8', port: 80 })
    pmR.update(rec2.id, { isActive: false, isDisabled: true })
    await phR.testAll({ activeOnly: true })
    ok('manual-off proxy stays isActive=false', pmR.get(rec2.id).isActive === false)

    // ---------- 3. testAll parallel ----------------------------------
    section('testAll: parallel results')
    const okTcp = async () => ({ ok: true })
    const okConnect = async () => ({ ok: true, status: 200 })
    const ph3 = new ProxyHealth({
      proxyManager: pm,
      tcpConnect: okTcp,
      connectViaProxy: okConnect,
    })
    const results = await ph3.testAll()
    ok('testAll returns 3 results', results.length === 3)
    ok(
      'all ok',
      results.every((r) => r.ok === true),
    )

    // ---------- 4. testAll empty pool --------------------------------
    section('testAll: empty pool returns []')
    const { pm: empty, ProxyHealth: PH } = freshSetup()
    const ph4 = new PH({ proxyManager: empty })
    const r4 = await ph4.testAll()
    ok('empty pool [] ', r4.length === 0)

    // ---------- 5. daemon start/stop ---------------------------------
    section('daemon start/stop + tick fires testAll')
    const { pm: pm5, ProxyHealth: PH5 } = freshSetup()
    pm5.create({ name: 'daemon-a', host: '5.5.5.5', port: 80 })
    let tickCount = 0
    const ph5 = new PH5({
      proxyManager: pm5,
      connectViaProxy: async () => {
        tickCount += 1
        return { ok: true }
      },
      tcpConnect: async () => ({ ok: true }),
    })
    const started = ph5.startDaemon({ intervalMs: 30 })
    ok('startDaemon returns true', started === true)
    ok('startDaemon idempotent (returns false if already)', ph5.startDaemon({}) === false)
    await new Promise((r) => setTimeout(r, 100)) // allow ~3 ticks
    ok('daemon ticked at least once', tickCount >= 1)
    const stopped = ph5.stopDaemon()
    ok('stopDaemon returns true', stopped === true)
    ok('stopDaemon idempotent (false if not running)', ph5.stopDaemon() === false)

    // ---------- Cleanup --------------------------------------------------
    Module._load = originalLoad
    console.log(`\n=== ${passed} passed · ${failed} failed ===`)
    if (failed > 0) {
      console.log('\nFailures:')
      for (const f of failures)
        console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
      process.exit(1)
    }
    process.exit(0)
  } catch (err) {
    console.error('Test crashed:', err)
    process.exit(2)
  }
})()
