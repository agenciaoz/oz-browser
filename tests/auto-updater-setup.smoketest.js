// OZ Browser — auto-updater-setup smoke test (v2.0.0-alpha.31).
//
// Cómo correr:
//   cd oz-browser
//   node tests/auto-updater-setup.smoketest.js
//
// Cubre el fix de alpha.31: _safeCheck() absorbe el rechazo de la promesa
// de checkForUpdates() cuando estamos offline / resumiendo de sleep
// (net::ERR_INTERNET_DISCONNECTED). Sin esto, ese rechazo escalaba al
// handler global `unhandledRejection` → dialog "Unhandled promise rejection
// (main process)" molesto al user (ver oz-browser.log 2026-06-08).
//
// El módulo redirige su logger a ./logger, que en contexto de test sin
// Electron puede fallar. Para aislar, stubbeamos require('./logger') antes
// de cargar el módulo bajo test.

const assert = require('assert')
const Module = require('module')

// ---- Stub ./logger antes de require del módulo bajo test ----
const loggerCalls = { info: [], warn: [], error: [], debug: [] }
const fakeLogger = {
  info: (src, msg, meta) => loggerCalls.info.push({ src, msg, meta }),
  warn: (src, msg, meta) => loggerCalls.warn.push({ src, msg, meta }),
  error: (src, msg, meta) => loggerCalls.error.push({ src, msg, meta }),
  debug: (src, msg, meta) => loggerCalls.debug.push({ src, msg, meta }),
}
const _origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === './logger' || request.endsWith('/logger')) return fakeLogger
  return _origLoad.apply(this, arguments)
}

const { _safeCheck } = require('../browser/auto-updater-setup')

Module._load = _origLoad // restore

let testsRun = 0
let testsPassed = 0
function test(name, fn) {
  testsRun++
  Promise.resolve()
    .then(fn)
    .then(() => {
      testsPassed++
      console.log(`  ✓ ${name}`)
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`)
      console.error(`    ${err.message}`)
    })
}

console.log('\n[auto-updater-setup] tests\n')

// Detector de unhandledRejection: si el fix falla, este flag se prende.
let sawUnhandled = false
process.on('unhandledRejection', () => {
  sawUnhandled = true
})

console.log('[_safeCheck]')

test('swallows a rejected checkForUpdates() — no unhandledRejection', async () => {
  const updater = {
    checkForUpdates: () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
  }
  const ret = _safeCheck(updater)
  assert.ok(ret && typeof ret.then === 'function', 'returns a promise')
  await ret // debe resolver, no rechazar
  // Da una vuelta extra al event loop para que cualquier rechazo no atrapado
  // dispare el handler global antes de assertear.
  await new Promise((r) => setImmediate(r))
  assert.strictEqual(sawUnhandled, false, 'no unhandledRejection escaped')
  const dbg = loggerCalls.debug.find((c) => /check rejected/.test(c.msg))
  assert.ok(dbg, 'logs a debug breadcrumb')
  assert.strictEqual(dbg.meta.message, 'net::ERR_INTERNET_DISCONNECTED')
})

test('resolves cleanly on a successful check', async () => {
  const updater = { checkForUpdates: () => Promise.resolve({ updateInfo: {} }) }
  await _safeCheck(updater)
  assert.strictEqual(sawUnhandled, false)
})

test('handles a synchronous throw without crashing', async () => {
  const updater = {
    checkForUpdates: () => {
      throw new Error('sync boom')
    },
  }
  await _safeCheck(updater) // no throw
  const warn = loggerCalls.warn.find((c) => /threw synchronously/.test(c.msg))
  assert.ok(warn, 'logs a warn on sync throw')
  assert.strictEqual(warn.meta.message, 'sync boom')
})

test('tolerates a non-promise return (old electron-updater)', async () => {
  const updater = { checkForUpdates: () => undefined }
  await _safeCheck(updater) // no throw
  assert.strictEqual(sawUnhandled, false)
})

// ---- Summary (deferred: tests son async) ----
setTimeout(() => {
  console.log(`\n[auto-updater-setup] ${testsPassed}/${testsRun} passed\n`)
  process.exit(testsPassed === testsRun ? 0 : 1)
}, 200)
