// OZ Browser — power-monitor-setup smoke test (K1-extras, v1.4.2).
//
// Cómo correr:
//   cd oz-browser
//   node tests/power-monitor-setup.smoketest.js
//
// Pure test — inyecta fakes para powerMonitor / proxyHealth / settingsManager.
// NO toca Electron real.

const Module = require('module')
const fakeElectron = { app: { getPath: () => '/tmp', getVersion: () => '0.1.0-test' } }
const orig = Module._load
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron
  return orig.call(this, req, parent, ...rest)
}

delete require.cache[require.resolve('../browser/power-monitor-setup.js')]
const {
  setupPowerMonitor,
  DEFAULT_DEBOUNCE_MS,
  SETTING_KEY,
} = require('../browser/power-monitor-setup.js')

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

console.log('OZ Browser — power-monitor-setup smoke test')

function makeFakePowerMonitor() {
  const listeners = {}
  return {
    on(event, fn) {
      ;(listeners[event] = listeners[event] || []).push(fn)
    },
    removeListener(event, fn) {
      const arr = listeners[event]
      if (!arr) return
      const idx = arr.indexOf(fn)
      if (idx >= 0) arr.splice(idx, 1)
    },
    emit(event) {
      for (const fn of listeners[event] || []) fn()
    },
    _listeners: listeners,
  }
}

function makeFakeProxyHealth() {
  const calls = []
  return {
    calls,
    async testAll(opts) {
      calls.push(opts || {})
      return { ok: 5, total: 5 }
    },
  }
}

// ============================================================================
console.log('\ndefensive guards')
// ============================================================================

ok(
  'no proxyHealth → returns no-op stop()',
  (() => {
    const r = setupPowerMonitor({ powerMonitor: makeFakePowerMonitor() })
    return r && typeof r.stop === 'function'
  })(),
)

ok(
  'no powerMonitor → returns no-op stop()',
  (() => {
    const r = setupPowerMonitor({ proxyHealth: makeFakeProxyHealth() })
    return r && typeof r.stop === 'function'
  })(),
)

ok('exports SETTING_KEY = macSleepProxyRescan', SETTING_KEY === 'macSleepProxyRescan')
ok('exports DEFAULT_DEBOUNCE_MS = 3000', DEFAULT_DEBOUNCE_MS === 3000)

// ============================================================================
console.log('\nlistener registration')
// ============================================================================

{
  const pm = makeFakePowerMonitor()
  const ph = makeFakeProxyHealth()
  const r = setupPowerMonitor({ proxyHealth: ph, powerMonitor: pm, debounceMs: 50 })
  ok(
    'powerMonitor.on(resume, ...) was registered',
    Array.isArray(pm._listeners.resume) && pm._listeners.resume.length === 1,
  )
  r.stop()
  ok(
    'stop() removed the listener',
    !pm._listeners.resume || pm._listeners.resume.length === 0,
  )
}

// ============================================================================
console.log('\n_trigger fires testAll')
// ============================================================================
;(async () => {
  const pm = makeFakePowerMonitor()
  const ph = makeFakeProxyHealth()
  const r = setupPowerMonitor({ proxyHealth: ph, powerMonitor: pm, debounceMs: 10 })

  const result = await r._trigger('manual-test')
  ok(
    'trigger → testAll called once + result.ok=true',
    ph.calls.length === 1 && result && result.ok === true,
  )

  // ============================================================================
  console.log('\nsettings opt-out')
  // ============================================================================

  const ph2 = makeFakeProxyHealth()
  const settingsManager = {
    get(section) {
      if (section === 'notifications') return { macSleepProxyRescan: false }
      return null
    },
  }
  const r2 = setupPowerMonitor({
    proxyHealth: ph2,
    powerMonitor: makeFakePowerMonitor(),
    settingsManager,
    debounceMs: 10,
  })
  const skippedResult = await r2._trigger('settings-off')
  ok(
    'settings disabled → skipped:true, reason:disabled, testAll NOT called',
    skippedResult.skipped === true &&
      skippedResult.reason === 'disabled' &&
      ph2.calls.length === 0,
  )

  // settings undefined (default true) → still fires
  const ph3 = makeFakeProxyHealth()
  const r3 = setupPowerMonitor({
    proxyHealth: ph3,
    powerMonitor: makeFakePowerMonitor(),
    settingsManager: {
      get: () => null,
    },
    debounceMs: 10,
  })
  await r3._trigger('default-on')
  ok('settings undefined → defaults true, testAll fires', ph3.calls.length === 1)

  // ============================================================================
  console.log('\ndebounce — rapid emits coalesce to ONE testAll')
  // ============================================================================

  const pm4 = makeFakePowerMonitor()
  const ph4 = makeFakeProxyHealth()
  setupPowerMonitor({ proxyHealth: ph4, powerMonitor: pm4, debounceMs: 80 })
  // Three rapid emits within the debounce window.
  pm4.emit('resume')
  pm4.emit('resume')
  pm4.emit('resume')
  await new Promise((res) => setTimeout(res, 150))
  ok(
    '3 rapid resume events → testAll called only ONCE (coalesced)',
    ph4.calls.length === 1,
  )

  // ============================================================================
  console.log('\nerror handling — testAll throws')
  // ============================================================================

  const phThrow = {
    async testAll() {
      throw new Error('upstream-fail')
    },
  }
  const r5 = setupPowerMonitor({
    proxyHealth: phThrow,
    powerMonitor: makeFakePowerMonitor(),
    debounceMs: 10,
  })
  const errResult = await r5._trigger('throw-test')
  ok(
    'testAll throws → result.ok=false, error captured (no rethrow)',
    errResult.ok === false && /upstream-fail/.test(errResult.error || ''),
  )

  // ============================================================================
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f.label}`)
    process.exit(1)
  }
  process.exit(0)
})()
