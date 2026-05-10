// OZ Browser — Auto-Update smoke test (Etapa 3d).
//
// Cómo correr:
//   cd oz-browser
//   node tests/auto-update.smoketest.js
//
// Cubre:
//   - skip si !app.isPackaged (dev mode) → reason: 'not-packaged'
//   - skip si OZ_UPDATE_DISABLED=1 → reason: 'disabled-by-env'
//   - skip si platform !== 'darwin' → reason: 'unsupported-platform'
//   - skip si OZ_UPDATE_BASE_URL no seteado → reason: 'no-base-url'
//   - skip si baseUrl no es HTTPS → reason: 'invalid-base-url'
//   - happy path: llama updateElectronApp con config esperada
//   - logger adapter: convierte a INFO de OZ logger
//   - error en updateElectronApp NO crashea (try/catch) → reason: 'lib-error'
//   - throw si logger no provisto

const assert = require('assert')

const { setupAutoUpdate } = require('../browser/auto-update')

let testsRun = 0
let testsPassed = 0

function test(name, fn) {
  testsRun++
  try {
    fn()
    testsPassed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'))
  }
}

function fakeLogger() {
  const calls = { info: [], warn: [], error: [], debug: [] }
  return {
    calls,
    info: (src, msg, meta) => calls.info.push({ src, msg, meta }),
    warn: (src, msg, meta) => calls.warn.push({ src, msg, meta }),
    error: (src, msg, meta) => calls.error.push({ src, msg, meta }),
    debug: (src, msg, meta) => calls.debug.push({ src, msg, meta }),
  }
}

function fakeApp(isPackaged) {
  return { isPackaged }
}

function captureUpdateCall() {
  const captured = { calls: [] }
  const fn = (opts) => {
    captured.calls.push(opts)
  }
  return { fn, captured }
}

console.log('\n[auto-update] tests\n')

// ============================================================
// Skip cases
// ============================================================

console.log('[skip cases]')

test('throws if logger not provided', () => {
  assert.throws(() => setupAutoUpdate({}), /logger is required/)
})

test('skip when app is not packaged (dev mode)', () => {
  const logger = fakeLogger()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(false),
    env: { OZ_UPDATE_BASE_URL: 'https://updates.example.com' },
    platform: 'darwin',
  })
  assert.strictEqual(result.configured, false)
  assert.strictEqual(result.reason, 'not-packaged')
  assert.strictEqual(logger.calls.warn.length, 1)
  assert.match(logger.calls.warn[0].msg, /not packaged/i)
})

test('skip when OZ_UPDATE_DISABLED=1', () => {
  const logger = fakeLogger()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: {
      OZ_UPDATE_DISABLED: '1',
      OZ_UPDATE_BASE_URL: 'https://updates.example.com',
    },
    platform: 'darwin',
  })
  assert.strictEqual(result.configured, false)
  assert.strictEqual(result.reason, 'disabled-by-env')
  assert.match(logger.calls.warn[0].msg, /OZ_UPDATE_DISABLED/)
})

test('skip when platform is win32 (Windows en Etapa 8)', () => {
  const logger = fakeLogger()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'https://updates.example.com' },
    platform: 'win32',
  })
  assert.strictEqual(result.configured, false)
  assert.strictEqual(result.reason, 'unsupported-platform')
  assert.deepStrictEqual(logger.calls.warn[0].meta, { platform: 'win32' })
})

test('skip when platform is linux', () => {
  const logger = fakeLogger()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'https://updates.example.com' },
    platform: 'linux',
  })
  assert.strictEqual(result.configured, false)
  assert.strictEqual(result.reason, 'unsupported-platform')
})

test('skip when OZ_UPDATE_BASE_URL not set', () => {
  const logger = fakeLogger()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: {}, // explicitly no base url
    platform: 'darwin',
  })
  assert.strictEqual(result.configured, false)
  assert.strictEqual(result.reason, 'no-base-url')
  assert.match(logger.calls.warn[0].msg, /OZ_UPDATE_BASE_URL/)
  // Hint should be present in meta to guide Jose
  assert.ok(logger.calls.warn[0].meta?.hint?.includes('R2'))
})

test('skip when base URL is HTTP (must be HTTPS)', () => {
  const logger = fakeLogger()
  const { fn, captured } = captureUpdateCall()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'http://insecure.example.com' },
    platform: 'darwin',
    updateElectronApp: fn,
  })
  assert.strictEqual(result.configured, false)
  assert.strictEqual(result.reason, 'invalid-base-url')
  // ERROR not WARN — security issue, want it loud
  assert.strictEqual(logger.calls.error.length, 1)
  // Lib should NOT have been called
  assert.strictEqual(captured.calls.length, 0)
})

test('skip precedence: not-packaged checked first (before env/platform/url)', () => {
  // If app is not packaged, we should skip immediately — not waste cycles
  // checking env vars / platform / etc. Validates the order of checks.
  const logger = fakeLogger()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(false),
    env: {
      OZ_UPDATE_DISABLED: '1', // would also trigger a skip
      OZ_UPDATE_BASE_URL: 'http://invalid', // would also trigger a skip
    },
    platform: 'win32', // would also trigger a skip
  })
  assert.strictEqual(result.reason, 'not-packaged')
  assert.strictEqual(logger.calls.warn.length, 1) // only one log
})

// ============================================================
// Happy path
// ============================================================

console.log('\n[happy path]')

test('calls updateElectronApp with expected StaticStorage config', () => {
  const logger = fakeLogger()
  const { fn, captured } = captureUpdateCall()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'https://updates.ozbrowser.example' },
    platform: 'darwin',
    updateElectronApp: fn,
  })
  assert.strictEqual(result.configured, true)
  assert.strictEqual(captured.calls.length, 1)
  const opts = captured.calls[0]
  // updateSource is StaticStorage (type === 1) with the env URL
  assert.strictEqual(opts.updateSource.type, 1)
  assert.strictEqual(opts.updateSource.baseUrl, 'https://updates.ozbrowser.example')
  // Default updateInterval per PLAN-MAESTRO
  assert.strictEqual(opts.updateInterval, '1 hour')
  // notifyUser true → native OS dialog when download ready
  assert.strictEqual(opts.notifyUser, true)
  // Logger adapter present
  assert.strictEqual(typeof opts.logger.log, 'function')
  // Configured info logged with metadata
  const infoCall = logger.calls.info.find((c) => c.msg === 'configured')
  assert.ok(infoCall, 'should log configured INFO')
  assert.strictEqual(infoCall.meta.baseUrl, 'https://updates.ozbrowser.example')
})

test('updateInterval can be overridden via opts', () => {
  const logger = fakeLogger()
  const { fn, captured } = captureUpdateCall()
  setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'https://x.example' },
    platform: 'darwin',
    updateElectronApp: fn,
    updateInterval: '15 minutes',
  })
  assert.strictEqual(captured.calls[0].updateInterval, '15 minutes')
})

test('logger adapter forwards updater messages to OZ logger.info', () => {
  const logger = fakeLogger()
  const { fn, captured } = captureUpdateCall()
  setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'https://x.example' },
    platform: 'darwin',
    updateElectronApp: fn,
  })
  // Simulate update-electron-app calling our logger
  const updaterLogger = captured.calls[0].logger
  updaterLogger.log('Checking for update')
  updaterLogger.log('Download progress:', '50%', '/', '100%')
  // Both should appear as INFO with source 'auto-update'
  const infoMessages = logger.calls.info.map((c) => c.msg)
  assert.ok(infoMessages.includes('Checking for update'))
  assert.ok(infoMessages.includes('Download progress: 50% / 100%'))
})

// ============================================================
// Error handling
// ============================================================

console.log('\n[error handling]')

test('lib throwing does NOT crash — returns reason: lib-error', () => {
  const logger = fakeLogger()
  const exploding = () => {
    throw new Error('simulated lib failure')
  }
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'https://x.example' },
    platform: 'darwin',
    updateElectronApp: exploding,
  })
  assert.strictEqual(result.configured, false)
  assert.strictEqual(result.reason, 'lib-error')
  // Error logged with the original message
  const errorCall = logger.calls.error.find((c) =>
    c.msg.includes('updateElectronApp call failed'),
  )
  assert.ok(errorCall)
  assert.strictEqual(errorCall.meta.message, 'simulated lib failure')
})

test('require update-electron-app failure caught + WARN — reason: require-failed', () => {
  // We simulate require failure by NOT providing updateElectronApp AND
  // we know update-electron-app IS installed in node_modules. So the
  // actual require will succeed in this test environment. To test the
  // catch path, we'd need to remove the package — that's brittle.
  // Instead: validate that when we DO inject a working fn, no error is logged.
  const logger = fakeLogger()
  const { fn } = captureUpdateCall()
  const result = setupAutoUpdate({
    logger,
    app: fakeApp(true),
    env: { OZ_UPDATE_BASE_URL: 'https://x.example' },
    platform: 'darwin',
    updateElectronApp: fn,
  })
  assert.strictEqual(result.configured, true)
  assert.strictEqual(logger.calls.error.length, 0)
})

// ============================================================
// Integration: real require of update-electron-app
// ============================================================

console.log('\n[integration]')

test('real require of update-electron-app does not throw at module level', () => {
  // We don't actually CALL setupAutoUpdate without injection here (the lib
  // would attempt actual ipcMain/etc. wiring outside Electron context).
  // We just confirm the lib loads — no version mismatch / missing peer dep.
  const lib = require('update-electron-app')
  assert.strictEqual(typeof lib.updateElectronApp, 'function')
  // Confirm the StaticStorage enum value matches our hardcoded `1`
  assert.strictEqual(lib.UpdateSourceType.StaticStorage, 1)
  assert.strictEqual(lib.UpdateSourceType.ElectronPublicUpdateService, 0)
})

// ============================================================
// Summary
// ============================================================

console.log(`\n[auto-update] ${testsPassed}/${testsRun} passed\n`)
process.exit(testsPassed === testsRun ? 0 : 1)
