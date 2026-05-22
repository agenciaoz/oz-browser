// OZ Browser — Bulk action browser helpers smoke test (v2 sub-bloque 3a).
//
// Tests con fakes de Electron — `BrowserWindow` + `webContents` stubs.
// Validation end-to-end real requiere OZ corriendo (smoke manual) porque
// los helpers wrappen capacidades nativas (capturePage, loadURL,
// executeJavaScript) que no son testeables sin Electron real.
//
// Cubre:
//   - spawnIdentityWindow construye con la partition correcta per identity
//   - safeClose es idempotente y absorbe errores
//   - navigate resuelve on did-finish-load, rechaza on did-fail-load
//     mainFrame, ignora fail subframe, respeta timeout, respeta abort
//   - waitForSelector polea y respeta timeout / abort
//   - click / type ejecutan JS y propagan errores not-found
//   - executeJS pasa through webContents.executeJavaScript

'use strict'

const { EventEmitter } = require('events')

const {
  spawnIdentityWindow,
  safeClose,
  navigate,
  waitForSelector,
  click,
  type: typeFn,
  executeJS,
} = require('../browser/bulk-action-browser-helpers')

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

// ---------- fake Electron ----------------------------------------------------

class FakeWebContents extends EventEmitter {
  constructor() {
    super()
    this._url = 'about:blank'
    this._title = ''
    this.executeJavaScriptCalls = []
    this._jsResults = []
    this.capturePageCalls = 0
  }
  getURL() {
    return this._url
  }
  getTitle() {
    return this._title
  }
  executeJavaScript(script) {
    this.executeJavaScriptCalls.push(script)
    const next = this._jsResults.shift()
    return Promise.resolve(typeof next === 'function' ? next(script) : next)
  }
  queueJsResult(v) {
    this._jsResults.push(v)
  }
  capturePage() {
    this.capturePageCalls++
    return Promise.resolve({
      toPNG: () => Buffer.from('fake-png-bytes'),
    })
  }
}

class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts
    this.webContents = new FakeWebContents()
    this.loadUrlCalls = []
    this._destroyed = false
  }
  loadURL(url) {
    this.loadUrlCalls.push(url)
    this.webContents._url = url
    return Promise.resolve()
  }
  isDestroyed() {
    return this._destroyed
  }
  destroy() {
    this._destroyed = true
  }
  close() {
    this._destroyed = true
  }
}

function fakeElectron() {
  return {
    BrowserWindow: FakeBrowserWindow,
  }
}

function fakeIdentityManager(identities) {
  const map = new Map(identities.map((i) => [i.id, i]))
  return {
    get(id) {
      return map.get(id) || null
    },
    getSession(_id) {
      return { __label: 'fake-session' }
    },
  }
}

// ---------- tests ------------------------------------------------------------

async function main() {
  // 1. spawnIdentityWindow
  section('spawnIdentityWindow')
  {
    const im = fakeIdentityManager([
      { id: 'id1', name: 'Alice', isDefault: false },
      { id: 'def', name: 'Default', isDefault: true },
    ])
    const el = fakeElectron()
    const win = await spawnIdentityWindow({
      identityManager: im,
      identityId: 'id1',
      electron: el,
    })
    ok('returns BrowserWindow', win instanceof FakeBrowserWindow)
    ok(
      'partition matches persist:identity-<id>',
      win.opts.webPreferences.partition === 'persist:identity-id1',
    )
    ok('show=false default (hidden)', win.opts.show === false)
    ok('sandbox enabled', win.opts.webPreferences.sandbox === true)
    ok('contextIsolation enabled', win.opts.webPreferences.contextIsolation === true)

    const defWin = await spawnIdentityWindow({
      identityManager: im,
      identityId: 'def',
      electron: el,
    })
    ok(
      'default identity uses undefined partition (defaultSession)',
      defWin.opts.webPreferences.partition === undefined,
    )

    let threw = false
    try {
      await spawnIdentityWindow({
        identityManager: im,
        identityId: 'ghost',
        electron: el,
      })
    } catch (e) {
      threw = /identity not found/.test(e.message)
    }
    ok('unknown identity → throws', threw)

    threw = false
    try {
      const ctrl = new AbortController()
      ctrl.abort()
      await spawnIdentityWindow({
        identityManager: im,
        identityId: 'id1',
        electron: el,
        signal: ctrl.signal,
      })
    } catch (e) {
      threw = e.name === 'AbortError'
    }
    ok('already-aborted signal → AbortError', threw)
  }

  // 2. safeClose
  section('safeClose')
  {
    const win = new FakeBrowserWindow({})
    await safeClose(win)
    ok('destroys window', win._destroyed === true)
    await safeClose(win) // second call
    ok('idempotent on destroyed', win._destroyed === true)
    await safeClose(null) // null
    ok('null is no-op', true)
  }

  // 3. navigate
  section('navigate')
  {
    const win = new FakeBrowserWindow({})
    const p = navigate(win, 'https://example.com', { timeoutMs: 1000 })
    setImmediate(() => {
      win.webContents._title = 'Example'
      win.webContents.emit('did-finish-load')
    })
    const result = await p
    ok('resolves on did-finish-load', result.url === 'https://example.com')
    ok('title returned', result.title === 'Example')
    ok('loadURL called', win.loadUrlCalls.includes('https://example.com'))
  }
  {
    // main-frame fail rejects
    const win = new FakeBrowserWindow({})
    const p = navigate(win, 'https://bad', { timeoutMs: 1000 })
    setImmediate(() => {
      win.webContents.emit(
        'did-fail-load',
        null,
        -106,
        'ERR_INTERNET_DISCONNECTED',
        'https://bad',
        true,
      )
    })
    let err
    try {
      await p
    } catch (e) {
      err = e
    }
    ok('main-frame fail rejects', err && /ERR_INTERNET_DISCONNECTED/.test(err.message))
    ok('error has code', err && err.code === -106)
  }
  {
    // subframe fail is IGNORED
    const win = new FakeBrowserWindow({})
    const p = navigate(win, 'https://example.com', { timeoutMs: 200 })
    setImmediate(() => {
      // subframe failure
      win.webContents.emit('did-fail-load', null, -2, 'ERR_FAILED', 'sub', false)
      setImmediate(() => {
        win.webContents.emit('did-finish-load')
      })
    })
    const r = await p
    ok('subframe fail ignored, resolves on main load', r.url === 'https://example.com')
  }
  {
    // timeout
    const win = new FakeBrowserWindow({})
    const start = Date.now()
    let err
    try {
      await navigate(win, 'https://slow', { timeoutMs: 50 })
    } catch (e) {
      err = e
    }
    const elapsed = Date.now() - start
    ok('rejects on timeout', err && /timeout/.test(err.message))
    ok('timeout fires near requested ms', elapsed >= 40 && elapsed < 200)
  }
  {
    // abort signal
    const win = new FakeBrowserWindow({})
    const ctrl = new AbortController()
    const p = navigate(win, 'https://ok', { timeoutMs: 1000, signal: ctrl.signal })
    setImmediate(() => ctrl.abort())
    let err
    try {
      await p
    } catch (e) {
      err = e
    }
    ok('abort rejects with AbortError', err && err.name === 'AbortError')
  }

  // 4. waitForSelector
  section('waitForSelector')
  {
    const win = new FakeBrowserWindow({})
    win.webContents.queueJsResult(false)
    win.webContents.queueJsResult(false)
    win.webContents.queueJsResult(true) // appears on 3rd poll
    const r = await waitForSelector(win, '.target', { pollMs: 5, timeoutMs: 500 })
    ok('returns true on found', r === true)
    ok('polled multiple times', win.webContents.executeJavaScriptCalls.length >= 3)
  }
  {
    const win = new FakeBrowserWindow({})
    // Never finds — queue infinite false. Wrap pop so it always returns false.
    for (let i = 0; i < 100; i++) win.webContents.queueJsResult(false)
    let err
    try {
      await waitForSelector(win, '.nope', { pollMs: 5, timeoutMs: 30 })
    } catch (e) {
      err = e
    }
    ok('rejects on timeout', err && /timeout/.test(err.message))
  }
  {
    const win = new FakeBrowserWindow({})
    for (let i = 0; i < 100; i++) win.webContents.queueJsResult(false)
    const ctrl = new AbortController()
    const p = waitForSelector(win, '.x', {
      pollMs: 5,
      timeoutMs: 1000,
      signal: ctrl.signal,
    })
    setTimeout(() => ctrl.abort(), 15)
    let err
    try {
      await p
    } catch (e) {
      err = e
    }
    ok('abort rejects with AbortError', err && err.name === 'AbortError')
  }

  // 5. click + type + executeJS
  section('click / type / executeJS')
  {
    const win = new FakeBrowserWindow({})
    win.webContents.queueJsResult({ ok: true })
    const r = await click(win, '#btn')
    ok('click resolves with ok:true', r.ok === true)
    ok(
      'script includes selector',
      win.webContents.executeJavaScriptCalls[0].includes('#btn'),
    )
  }
  {
    const win = new FakeBrowserWindow({})
    win.webContents.queueJsResult({ ok: false, reason: 'not-found' })
    let err
    try {
      await click(win, '#missing')
    } catch (e) {
      err = e
    }
    ok('click on missing → throws not-found', err && /not-found/.test(err.message))
  }
  {
    const win = new FakeBrowserWindow({})
    win.webContents.queueJsResult({ ok: true })
    const r = await typeFn(win, '#i', 'hola "amigo"')
    ok('type ok', r.ok === true)
    ok(
      'text properly escaped in JS',
      win.webContents.executeJavaScriptCalls[0].includes('"hola \\"amigo\\""'),
    )
  }
  {
    const win = new FakeBrowserWindow({})
    win.webContents.queueJsResult('result-blob')
    const r = await executeJS(win, '1+1')
    ok('executeJS returns webContents result', r === 'result-blob')
  }

  // ---------- Done ----------------------------------------------------------
  console.log(`\n=== ${passed} passed · ${failed} failed ===`)
  if (failed > 0) {
    console.log('\nFailures:')
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? ' :: ' + f.detail : ''}`)
    }
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Test harness crashed:', err)
  process.exit(1)
})
